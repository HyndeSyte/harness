"""Changing events on Family and his Gmail calendar, because he asked.

    his message -> a model's typed change -> plain code finds the event on a fresh read
                -> the write -> a read back -> one receipt with Undo

He said on Nov 5, 2026 that this should go with no tap, so a change he asks for needs none.
It's off until the add-on's `calendar_changes` option is on, which only he can decide. The
tap comes back for what may not be his own words, because something pasted can say anything,
and for anything a check finds off (`warnings`). The harness doesn't start a change itself:
there is no date list, and nothing here runs without a message from him behind it.

A model says what he said: which calendar, what the event is called, which days. It never
names an event itself. Plain code finds it on those days, on both calendars, before anything
is offered or done (Nov 11, his words: "his clear calendar commands execute with a receipt and
Undo, no approval tap"). His words match a title either way round: his short word in a longer
title ("PT" in "PT - Clinic"), or a title's usual long form ("physical therapy" for "PT"). A
Family copy this add-on made of a Gmail event counts as that event, and moves or goes with it in
the same change; a block it made on Gmail (a school run, a drive) is found where it is, whatever
calendar the model named. When exactly one event fits, that's the event; when two or more fit,
or none, he's asked once, by name, and nothing changes until he answers. A part that fails is
named with why; the other parts still go.

  * A write carries the version just read, so someone's edit in between isn't overwritten.
  * Each write is read back from the calendar before he hears it's done.
  * The event as it was is kept here, so Undo can put it back, unless someone changed it since.
  * An outcome a write can't confirm (a lost answer, a read back that fails or disagrees, a
    restart mid-request) is settled by reading, never handed to him (org rule R-004). Each
    write is recorded before it's sent, with the event as it was and what it should become, so
    a read can tell landed from not. The first read comes a minute after the write was sent.
    Landed is the usual receipt. Nothing landed means the very version it was written over:
    only then is it written once more, guarded by that version. The same content under a new
    version is someone's change since, left as it is and said so. Half of a part landed is
    finished, or else put back, and a put-back whose answer is lost is read before any receipt.
    What reads can't tell yet is read again each minute for the first hour, every 15 minutes
    until a day has passed, then hourly; said once after an hour as not confirmed yet, told once
    when it's known, and once the event is over or a week has passed, said once as not confirmed
    and read no more. Nothing is created twice: adds have fixed ids.
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

from . import (caldav, choices, commands, effects, family_copy, family_rules, google_cal, ical, ics_edit,
               render)
from .canonical import canonical_hash
from .family_add import GAVE_UP_WORDS, _looks_pasted, gave_up, read_due
from .ledger import Ledger, iso

log = logging.getLogger("harness.calendar_change")

UNDO_TTL_S = 7 * 24 * 3600
CONTEXT_BACK, CONTEXT_AHEAD, CONTEXT_MAX = timedelta(days=90), timedelta(days=60), 6
CONTEXT_NEAR = 20                      # today's and tomorrow's events, whatever they're called
RECENT, RECENT_MAX = timedelta(hours=2), 8     # what became of his last requests, for the model
_CONTEXT_SKIP = frozenset({"the", "and", "for", "are", "again", "next", "week", "weeks", "every", "with",
                           "then", "after", "that", "going", "forward", "this", "today", "tomorrow",
                           "two", "add", "put", "move", "take", "off", "calendar", "recurring", "on",
                           "from", "until", "each", "our", "his", "her", "him", "she", "you", "your"})
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
# An outcome no read has settled yet (_settle): read again on family_add.read_gap's schedule, and
# once reads have failed this many times over at least this long, he hears it isn't confirmed
# yet, once. They stop once the event is over or a week has passed (family_add.gave_up).
READ_AGAIN = timedelta(minutes=1)
STILL_CHECKING_AFTER = timedelta(hours=1)
STILL_CHECKING_PASSES = 3

WORDS = {"unknown": "I couldn't confirm it yet",
         "not_landed": "it didn't go through",
         "changed": "someone changed that event since, so I left it alone",
         "changed_since": "it was changed on the calendar since, so I left it as it is",
         "series_gone": "the series that day belongs to isn't on the calendar any more, so there's "
                        "nothing to put it back into",
         "gone": "that event isn't there any more",
         "auth": "the calendar refused the password or key on the Harness page",
         "mismatch": "the saved address isn't the Family calendar",
         "no_credentials": "the calendar's sign-in isn't set on the Harness page",
         "no_key": "the Google key isn't set on the Harness page",
         "denied": "Google says this calendar isn't shared for changes",
         "exists": "that one is already there"}
STOPPED_UNDO = "I'm stopped, so I didn't undo that. It comes back as its own card after you turn me back on."
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


# Two names for one thing, either way round: his short word and a title's long form, or the
# other way (Nov 11: he said "PT" and "physical therapy" for "PT - Clinic", and "drop-off" for
# the school run Harness puts on his Gmail calendar as "Busy (school drop-off)").
_SAME = tuple((re.compile(rf"(?<![^\W_]){pattern}(?![^\W_])", re.I), word) for pattern, word in (
    (r"physical[\s-]*therap(?:y|ies|ist)|physio(?:therapy)?|p\.\s?t\.", "pt"),
    (r"occupational[\s-]*therap(?:y|ist)|o\.\s?t\.", "ot"),
    (r"drop[\s-]*offs?", "dropoff"),
    (r"pick[\s-]*ups?", "pickup"),
    (r"appointments?|appts?\.?", "appointment"),
    (r"doctors?|dr\.?", "doctor"),
    (r"dentists?|dental", "dentist"),
))
# His words that say which day or what kind of thing, not which event: left out when he named
# it with more than these.
_FILLER = frozenset({"the", "a", "an", "my", "our", "his", "her", "their", "its", "this", "that", "today",
                     "tomorrow", "tonight", "morning", "afternoon", "evening", "appointment", "event", "on",
                     "at", "in", "for", "with", "of", "to", "and", "from", "monday", "tuesday", "wednesday",
                     "thursday", "friday", "saturday", "sunday", "next", "session", "visit", "s"})
# A clock time in his words ("the 8:00 drop-off", "PT at 11:30am"): which one, not what it's called.
_CLOCK = re.compile(r"(?i)(?<![\w:+-])(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![\w])"
                    r"|(?<![\w:+-])(\d{1,2}):([0-5]\d)(?![\w:])|\bnoon\b")
EXACT, HEAD, PART = 3, 2, 1            # his words are the whole name, all before its dash, or in it
_RUN_WORDS = frozenset({"dropoff", "pickup", "drive", "busy", "run", "kids"})   # a block's own words


def _norm(text: str) -> str:
    text = re.sub(r"['’]s\b", "", text.casefold())
    for rx, word in _SAME:
        text = rx.sub(f" {word} ", text)
    return text


def title_words(text: str) -> frozenset[str]:
    """A title's words, each in one form: an emoji or spacing doesn't matter, "school" can't
    match "homeschool", and "drop-off" is "drop off"."""
    return frozenset(_WORD.findall(_norm(text)))


def said(asked: str) -> tuple[frozenset[str], tuple[tuple[int, int, str], ...]]:
    """What he called it, and any clock time he gave it: (hour, minute, "a" | "p" | "")."""
    times: list[tuple[int, int, str]] = []

    def keep(m: re.Match) -> str:
        if m.group(0).casefold() == "noon":
            times.append((12, 0, "p"))
        elif m.group(1):
            times.append((int(m.group(1)), int(m.group(2) or 0), m.group(3).casefold()))
        else:
            times.append((int(m.group(4)), int(m.group(5)), ""))
        return " "
    words = title_words(_CLOCK.sub(keep, asked))
    return (words - _FILLER) or words, tuple(times)


def fit(asked: str, title: str) -> int:
    """EXACT: his words are the title's. HEAD: they're all of it before its dash, like "PT" for
    "PT - Clinic". PART: they're in it, like "drop-off" in "Busy (school drop-off)" or "PT" in
    "PT insurance call". 0: it isn't what he named."""
    want, _ = said(asked)
    have = title_words(title)
    if not want or not have:
        return 0
    if want == have or want == have - _FILLER:
        return EXACT
    head = title_words(_event_head(title))
    if head != have and (want == head or want == head - _FILLER):
        return HEAD
    return PART if want <= have else 0


_SHIFT = r"(?!\s*(?:earlier|later|early|late|before|after|sooner|back|forward|ahead))"
_NUMBER = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3}


def durations(text: str) -> set[int]:
    """Lengths he gave in words, in minutes: "45 minutes", "an hour and a half", "half an hour".
    Not a shift: "30 minutes earlier" says when, not how long."""
    t = " ".join(text.casefold().split())
    out = {int(m.group(1)) for m in re.finditer(r"\b(\d{1,3})\s*(?:mins?|minutes?)\b" + _SHIFT, t)}
    for m in re.finditer(r"(?<!half )\b(an?|one|two|three|\d{1,2}(?:\.5)?)\s*(?:hrs?|hours?)\b(\s+and\s+a\s+half)?"
                         + _SHIFT, t):
        hours = _NUMBER.get(m.group(1)) or float(m.group(1))
        out.add(int(hours * 60) + (30 if m.group(2) else 0))
    if re.search(r"\bhalf\s+an?\s+hour\b" + _SHIFT, t):
        out.add(30)
    return out


def matches(asked: str, title: str) -> bool:
    """Every word he used is in the title, in either form of it."""
    return fit(asked, title) > 0


def pick_titles(asked: str, titles: set[str]) -> list[str]:
    """What he could mean. The exact title wins: "School Day" isn't "School Day Pictures"."""
    scored = {t: fit(asked, t) for t in titles}
    best = max(scored.values(), default=0)
    return sorted(t for t, s in scored.items() if s and s == best)


def _safe(text: str) -> str:
    """Text from a calendar, for his chat. Anyone can put a title on his calendar by invite,
    so it can't be a link or a command. A dash he didn't type reads as a hyphen."""
    return render.family_text(render.defang(render.no_dashes(text)))


_BLOCK = re.compile(r"(?:maybe )?busy \((?:school )?(.+?)\)$", re.I)


def block_name(title: str) -> str:
    """One of Harness's own blocks, by what it's for: "Busy (school drop-off)" is the drop-off."""
    m = _BLOCK.match(title.strip())
    return m.group(1) if m else title


def _event_head(title: str) -> str:
    """How a title like "PT — Clinic" is said: the part before the dash."""
    head = re.split(r"\s+[—–]\s+", title.strip(), maxsplit=1)[0].strip()
    return head or title


_WEEKDAY_WORDS = {"MO": "Monday", "TU": "Tuesday", "WE": "Wednesday", "TH": "Thursday", "FR": "Friday",
                  "SA": "Saturday", "SU": "Sunday"}


def _day_words(day: date) -> str:
    return f"{day:%b} {day.day}"


def _list(days: list[date]) -> str:
    return ", ".join(_day_words(d) for d in sorted(days))


def _dates(text: str) -> list[date]:
    return sorted({date.fromisoformat(x) for x in text.split(",") if x})


def _when(text: str) -> datetime | date:
    return date.fromisoformat(text) if effects.DATE_RE.fullmatch(text) else datetime.fromisoformat(text)


class Refuse(Exception):
    """Nothing was written. His words, as plain text: escaped where they're sent."""


class Unclear(Refuse):
    """What he named isn't one event: none fits, or more than one does. He's asked, by name;
    `ask` is the question, which only makes sense before anything is approved."""

    def __init__(self, words: str, ask: str = ""):
        super().__init__(words)
        self.ask = ask


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
    calendar: str = ""                 # "family" or "gmail"
    end: Any = None
    copies: list = field(default_factory=list)   # on Gmail: this add-on's copies of it on Family
    taken: list = field(default_factory=list)    # on Gmail: his own Family events it keeps true
    copy_of: str = ""                  # on Family: a copy's key (family_copy.py), if it is one
    block: str = ""                    # on Gmail: a block this add-on made (family_gmail.py): its key


@dataclass
class Step:
    """One write, already decided."""
    label: str
    run: Callable[[], dict]            # does it: what Undo needs, or raises Stopped
    removed: list[tuple] = field(default_factory=list)   # (calendar, uid, instance, title, day)
    what: str = ""                     # where it lands, for a part that only partly goes: "Gmail"
    rows: list[dict] = field(default_factory=list)       # this add-on's own records it keeps true
    spec: dict = field(default_factory=dict)             # how to build it again after a restart


@dataclass
class Part:
    """One thing he asked for, in his words, and the writes that do it: an event on Gmail and
    its Family copy are one part."""
    will: str                          # "Move PT to 11:30 to 12:30 today (Gmail and Family)"
    done: str                          # "Moved PT to 11:30 to 12:30 today (Gmail and Family)"
    steps: list[Step]
    key: tuple = ()                    # the event and what happens to it: the same part twice is once
    removes: int = 0                   # events it takes off, his own and Family's, copies not counted
    ends: str = ""                     # a series it ends: every day of it from then on goes
    length: tuple = ()                 # a move that changes its length: (was, now, new end, name)
    name: str = ""                     # the event as he'd name it, made safe: "PT"
    adds: bool = False                 # a new event, not one already there
    warns: list[str] = field(default_factory=list)       # facts for the card, from the read


@dataclass
class Preview:
    """What a change will do, found on a fresh read, and what to check before it does."""
    lines: list[str]
    checks: list[str] = field(default_factory=list)


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
        # The step being run: (proposal, plan, its record, the version a retry must find, or None).
        self._recording: tuple | None = None
        self._undoing: tuple | None = None     # the undo being run: (proposal, its steps left)
        self._putting_back: tuple | None = None    # a half-done part being put back: (proposal, plan)

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
                "turn the calendar_changes option off, restart Harness, then turn it on again.")

    # -- a proposal arrives ----------------------------------------------------------------
    def refuse(self, job, receipt: dict, params: dict) -> bool:
        """True when this goes no further; the words are queued."""
        if commands.is_paused(self.ledger):
            words, state, why = "I'm stopped, so nothing changed.", "cancelled", "stopped"
            with self.ledger.tx() as db:
                commands.note_stopped(self.ledger, job["id"], db)   # its card comes after /resume
        elif not self.on():
            words, state, why = ("Changing calendar events is off, so nothing changed. It's the "
                                 "calendar_changes option in Harness's settings."), "no_action", "off"
        elif any(c["op"] in ("add", "add_series") and (render.has_link(c["title"]) or render.has_link(c["location"]))
                 for c in params["changes"]):
            words, state, why = ("Nothing changed: the title or location has a link or web address in "
                                 "it, and I don't put those on a calendar."), "no_action", "link"
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

    # -- before anything is offered or done: is it clear? ------------------------------------
    def preview(self, job, receipt: dict, params: dict) -> Preview | None:
        """Every event he names, found on a fresh read of both calendars, before anything is
        offered or done. Clear: what will happen, a line each, for the card or the run, and what
        to check first, which puts it on a card to tap: a length he didn't give, three or more
        events taken off at once, or a series ended. Unclear: one question naming what's unclear,
        and None: the job waits for his answer, and nothing changes. Not possible: said in words,
        and None. When the read itself goes wrong here, no lines: the run reads again and says
        what it finds."""
        try:
            parts, _ = self._plan_all(params, "preview")
        except Unclear as why:
            self._ask(job, receipt, f"Nothing changed: {why}." + (f" {why.ask}" if why.ask else ""))
            return None
        except Refuse as why:
            # Titles in it come from a calendar anyone can invite him to: made safe, like a receipt.
            log.info("calendar change job %s: not possible, said why", render.short(job["id"]))
            with self.ledger.tx() as db:
                self.ledger.transition(job["id"], "no_action", db=db, receipt=json.dumps(
                    {**receipt, "reason": "calendar_change_impossible"}))
                self._say(db, job["chat_id"], job["id"], f"Nothing changed: {_safe(str(why))}.")
            return None
        except (ValueError, KeyError, TypeError, ical.Unreadable, ics_edit.Cant) as e:
            log.warning("calendar change job %s: couldn't preview (%s)", render.short(job["id"]),
                        type(e).__name__)
            return Preview([])
        checks = self._checks(job, parts)
        log.info("calendar change job %s: clear, %d part(s), %d check(s)", render.short(job["id"]),
                 len(parts), len(checks))
        return Preview([p.will for p in parts], checks)

    def _checks(self, job, parts: list[Part]) -> list[str]:
        """What a request found clear still can't do on its words alone. Not judging what he
        meant: the shape of the change. A length the model worked out and he never gave; three
        or more events off at once; a series ended, which takes off days he didn't name. Pasted
        text can ask for any of those, so each gets his tap."""
        out = []
        words = self._his_words(job)
        _, times = said(words)
        for part in parts:
            if not part.length:
                continue
            was, now, end, name = part.length
            local = end.astimezone(ZoneInfo(self.tz))
            gave_end = any(self._same_clock(local, t) for t in times)
            if not gave_end and int(now.total_seconds() // 60) not in durations(words):
                out.append(f"{render.plain(name)} would be {_length(now)} long instead of {_length(was)}, and you "
                           "didn't give a new end or length.")
        removes = sum(part.removes for part in parts)
        if removes >= 3:
            out.append(f"this takes off {removes} events at once.")
        out += [f"it ends {render.plain(part.ends)}, taking off every day of it from then on." for part in parts
                if part.ends]
        out += [render.plain(w) for part in parts for w in part.warns]
        return out

    def _his_words(self, job) -> str:
        """What he said himself in the last half hour, this message included: never Cain's notes."""
        since = iso(self.ledger.now() - timedelta(minutes=30))
        rows = self.ledger.db.execute(
            "SELECT t.text FROM job_text t JOIN jobs j ON j.id=t.job_id WHERE j.chat_id=?"
            " AND (j.created_at>=? OR j.id=?) ORDER BY j.created_at", (job["chat_id"], since, job["id"]))
        return "\n".join(r["text"].split("\n\n[A suggestion from Cain", 1)[0] for r in rows)

    @staticmethod
    def _same_clock(t: datetime, said_time: tuple) -> bool:
        hour, minute, half = said_time
        hours = {hour % 12 + (12 if half == "p" else 0)} if half else {hour % 12, hour % 12 + 12}
        return t.hour in hours and t.minute == minute

    def _ask(self, job, receipt: dict, question: str) -> None:
        """Once, by name. His answer is a new message, with this one before it."""
        log.info("calendar change job %s: unclear, asked", render.short(job["id"]))
        with self.ledger.tx() as db:
            self.ledger.transition(job["id"], "needs_clarification", db=db, receipt=json.dumps(
                {**receipt, "reason": "calendar_change_unclear"}))
            self.ledger.enqueue(chat_id=job["chat_id"], kind="answer", job_id=job["id"],
                                text=render.fit(_safe(question)), db=db)
            self.ledger.release_held(db=db)

    def recent(self, job_id: str) -> list[str]:
        """His calendar requests of the last two hours and what became of each, from the record
        and in the words he was sent, for the model: an answer never says nothing was proposed
        or changed when something was (Nov 11)."""
        zone = ZoneInfo(self.tz)
        out = []
        for p in self.ledger.db.execute(
                "SELECT p.id, p.job_id, p.state, p.params_json, p.created_at, x.undo_state, x.state AS done_state"
                " FROM proposals p LEFT JOIN calendar_changes x ON x.proposal_id=p.id WHERE p.effect_type=? AND"
                " p.created_at>=? AND p.job_id<>? ORDER BY p.created_at",
                (effects.CALENDAR_CHANGE, iso(self.ledger.now() - RECENT), job_id)).fetchall():
            raw = self.ledger.get_meta(f"calendar_change_lines:{p['id']}")
            try:
                lines = json.loads(raw) if raw else [render.change_line(c, self.tz, self.ledger.now())
                                                     for c in json.loads(p["params_json"])["changes"]]
            except (ValueError, KeyError, TypeError):
                lines = ["a calendar change"]
            landed = p["undo_state"] in ("open", "requested", "undoing")
            state = {"proposed": "offered on a card, waiting for his tap",
                     "approved": "approved, being done", "auto_approved": "being done",
                     "executing": "being done",
                     "executed": "undone at his tap" if p["undo_state"] == "undone" else "done",
                     "failed": "only partly done" if landed else "not done",
                     "declined": "he declined it, nothing changed",
                     "expired": "the card expired, nothing changed"}.get(p["state"], "not done, nothing changed")
            if p["done_state"] in ("unconfirmed", "settling"):
                state = ("not confirmed: reads couldn't tell whether it went through" if p["done_state"] == "unconfirmed"
                         else "written, not confirmed yet: being read")
            last = self.ledger.db.execute("SELECT text FROM outbox WHERE job_id=? ORDER BY id DESC LIMIT 1",
                                          (p["job_id"],)).fetchone()
            at = datetime.fromisoformat(p["created_at"]).astimezone(zone)
            told = f" He was told: {render.plain(last['text'])[:300]}" if last else ""
            out.append(f"{render.clock_words(at, suffix=True)}: "
                       f"{'; '.join(render.plain(x) for x in lines)}. Outcome: {state}.{told}")
        return out[-RECENT_MAX:]

    def note_lines(self, proposal_id: str, lines: list[str], db) -> None:
        """What a card offered, so the tap's reply says what will happen."""
        if lines:
            self.ledger.set_meta(f"calendar_change_lines:{proposal_id}", json.dumps(lines), db)

    def tap_words(self, proposal_id: str) -> str | None:
        """His Approve tap's reply: what will happen now. The receipt follows once it's done
        and read back."""
        raw = self.ledger.get_meta(f"calendar_change_lines:{proposal_id}")
        if not raw:
            return None
        try:
            lines = [str(x) for x in json.loads(raw)]
        except ValueError:
            return None
        return "Approved. Doing it now:\n" + "\n".join(lines)

    def warnings(self, job, params: dict, *, pasted_recently: bool) -> list[str]:
        """What gets a tap. Words that may not be his: a change can't start from what a paste
        says, or from a title in a receipt, which anyone can put there by invite. A reply to the
        harness's own answer is still him, unless what it answered looks pasted. Length and line
        breaks aren't a sign: he dictates (Nov 11)."""
        out = []
        if self.ledger.get_meta(TAP_BACK):
            out.append("you asked to check these with /checkadds.")
        text = self.ledger.job_text(job["id"])
        if _looks_pasted(text) or pasted_recently:
            out.append("your message or a recent one may be pasted text: it has a quoted line, an "
                       "email's header lines, a forward, a link, a phone number or words written to you.")
        elif self._reply_may_be_foreign(job):
            out.append("it's a reply to a message whose words may not be yours, so it may be pasted text.")
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
        if not paused:
            self._settle_pending()
        now = self.ledger.now()
        for (pid,) in self.ledger.db.execute(           # newest first, read fresh: an undo before
                "SELECT proposal_id FROM calendar_changes WHERE undo_state IN ('requested','settling')"
                " ORDER BY rowid DESC").fetchall():      # it can hand this one new versions
            row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
            if row["undo_state"] == "settling" and (paused or not self._due(_plan(row).get("undo", {}), now)):
                continue                             # read again a minute after the last read
            self._undo(row, paused)
        if not paused and self.on():
            self._check_returned()

    def reconcile_after_restart(self) -> None:
        self._fail_orphans()
        for p in self._approved():
            # Never a resend ask: an interrupted job is run again by itself (runner.RETRYABLE).
            self._refused(p, "interrupted", "The harness restarted before it did that, so nothing "
                                            "changed.")
        # An undo the restart cut short: his tap asked for it, so it's finished by itself. It reads
        # each event first, and what's already back is left as it is (_undo_ready, _undo_step).
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_state='requested', updated_at=? WHERE"
                       " undo_state='undoing'", (iso(self.ledger.now()),))

    def forget(self) -> None:
        """A reset: every button that could reach a calendar goes, and this waits for him."""
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("UPDATE choices SET consumed_at=? WHERE consumed_at IS NULL"
                       " AND kind='calendar_change_undo'", (now,))
            db.execute("UPDATE calendar_changes SET undo_state='none', undo_json='[]'"
                       " WHERE undo_state IN ('open','requested','settling')")
            # Nothing waiting for a read writes or speaks for whoever pairs next.
            for r in db.execute("SELECT proposal_id, job_id FROM calendar_changes WHERE state='settling'"
                                ).fetchall():
                db.execute("UPDATE calendar_changes SET state='reset' WHERE proposal_id=?", (r["proposal_id"],))
                db.execute("UPDATE proposals SET state='failed' WHERE id=?", (r["proposal_id"],))
                self.ledger.transition(r["job_id"], "failed", db=db, receipt=json.dumps({"reason": "reset"}))
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
        """Writes are synchronous, so a row still "sending" belongs to a run that died mid-request.
        Each write was recorded before it was sent (_attempt), so it waits for a read like any
        write whose answer was lost: the one in flight is read, the ones after it may still run.
        Its first read comes a minute after it was sent, however soon the restart was, so a write
        that lands late shows before anything is written again."""
        now = iso(self.ledger.now())
        for row in self.ledger.db.execute(
                "SELECT * FROM calendar_changes WHERE state='sending'").fetchall():
            plan = _plan(row)
            if not plan.get("parts"):
                self._orphan_unplanned(row)
                continue
            for part in plan["parts"]:
                for rec in part["steps"]:
                    if rec["status"] == "trying":     # sent, or about to be: read it
                        rec["status"] = "unsure" if rec.get("entry") else "pending"
            sent = plan.get("read_at")                 # the last write's send time (_attempt)
            plan.update(since=plan.get("since") or sent or now, read_at=sent)
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET state='settling', settle_json=?, updated_at=?"
                           " WHERE proposal_id=?", (json.dumps(plan), now, row["proposal_id"]))

    def _orphan_unplanned(self, row) -> None:
        """Cut short while its writes were being planned: nothing was written, so it may run again
        by itself (runner.RETRYABLE). Or cut short mid-write by an earlier version, which kept no
        plan to read: what landed has its Undo, and nothing is written again, by the runner or
        here, since a write that did land would be made twice."""
        landed = json.loads(row["undo_json"])
        planning = _plan(row).get("planning")
        reason = "interrupted" if planning else "partway" if landed else "cut_short"
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET state='interrupted', undo_state=?, updated_at=?"
                       " WHERE proposal_id=?", ("open" if landed else "none", iso(self.ledger.now()),
                                                row["proposal_id"]))
            db.execute("UPDATE proposals SET state='failed' WHERE id=?", (row["proposal_id"],))
            self.ledger.transition(row["job_id"], "failed", db=db, receipt=json.dumps(
                {"reason": reason, "steps": len(landed)}))
            buttons, binds = self._undo_button(db, row["proposal_id"]) if landed else (None, None)
            if planning:
                words = "<b>Nothing changed.</b> That stopped before anything was written."
            else:
                words = ("<b>That was cut short.</b> A restart stopped it while it was writing, and the "
                         "version before this one kept no record of its writes, so I didn't write it again."
                         + (" Undo puts back what it recorded as written." if landed else ""))
            self._say(db, self.chat_id, row["job_id"], words, buttons=buttons, binds=binds)

    def _refused(self, p, reason: str, words: str) -> None:
        with self.ledger.tx() as db:
            if reason == "stopped":
                commands.note_stopped(self.ledger, p["job_id"], db)   # its card comes after /resume
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
            self._refused(p, "stopped", "I'm stopped, so nothing changed.")
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
                       " undo_json, created_at, updated_at, settle_json) VALUES(?,?,?,?,?,?,?,?)",
                       (p["id"], p["job_id"], "sending", "none", "[]", now, now,
                        json.dumps({"planning": True})))     # no write before its plan is kept
            db.execute("UPDATE proposals SET state='executing' WHERE id=?", (p["id"],))
        try:
            parts, notes = self._plan_all(params, p["id"])
        except Refuse as why:
            self._refused(p, "not_found", f"Nothing changed: {_safe(str(why))}.")
            return
        except (ValueError, KeyError, TypeError, ical.Unreadable, ics_edit.Cant):
            self._refused(p, "unreadable", "Nothing changed: I couldn't read one of those events.")
            return
        # Every write it will make, recorded before the first: a restart from here on is read, step
        # by step, never guessed at and never run twice (_fail_orphans, _settle).
        plan = {"notes": notes, "since": None, "read_at": None, "passes": 0, "told": False,
                "retried": False, "parts": [self._part_record(part) for part in parts]}
        self._save_plan(p["id"], plan)
        undo, results, unsure = [], [], False
        for pi, part in enumerate(parts):
            landed, stopped, at = [], None, None
            for si, step in enumerate(part.steps):
                rec = plan["parts"][pi]["steps"][si]
                outcome, entry, stopped = self._run_step(p["id"], plan, rec, step)
                if outcome == "landed":
                    landed.append(step)
                    undo.append(entry)
                    continue
                at = step
                unsure = unsure or outcome == "unsure"
                break                                # the rest of this part needs this step; other parts go on
            results.append((part, landed, stopped, at))
        self.touched = self.touched or bool(undo) or unsure
        if unsure:
            self._wait_for_read(p["id"], plan)       # he hears once a read settles it (_settle)
            return
        self._finish(p, results, undo, notes)

    # -- each write, recorded so a read can settle it -----------------------------------------
    def _part_record(self, part: Part) -> dict:
        return {"will": part.will, "done": part.done, "name": part.name, "adds": part.adds,
                "steps": [{"spec": step.spec, "label": step.label, "what": step.what, "rows": step.rows,
                           "removed": [[c, u, i, t, d.isoformat()] for c, u, i, t, d in step.removed],
                           "status": "pending", "entry": None, "kind": "", "words": ""}
                          for step in part.steps]}

    def _save_plan(self, pid: str, plan: dict, db=None) -> None:
        sql = "UPDATE calendar_changes SET settle_json=?, updated_at=? WHERE proposal_id=?"
        args = (json.dumps(plan), iso(self.ledger.now()), pid)
        if db is not None:
            db.execute(sql, args)
            return
        with self.ledger.tx() as d:
            d.execute(sql, args)

    def _attempt(self, entry: dict) -> None:
        """Just before a write is sent: what it is, and the event as it was. A restart or a lost
        answer after this is settled by a read against both (_seen_as). Its first read comes a
        minute after this. A retry writes only over the very version nothing landed on."""
        if self._recording is None:
            return
        pid, plan, rec, guard = self._recording
        if guard is not None and entry.get("was") != guard:
            # The version moved on since the read that found nothing landed. Not called someone's
            # edit yet: nothing is written, and a read says whose change it is (_settle).
            raise Stopped("changed", undo=rec.get("entry"))
        plan["seq"] = plan.get("seq", 0) + 1           # the order writes were sent in, for Undo
        rec.update(status="trying", entry=dict(entry), seq=plan["seq"])
        plan["read_at"] = iso(self.ledger.now())       # sent now: read a minute on, if it comes to that
        self._save_plan(pid, plan)

    def _run_step(self, pid: str, plan: dict, rec: dict, step: Step, unsure_if: tuple[str, ...] = ("unknown",),
                  guard: str | None = None) -> tuple[str, dict | None, Stopped | None]:
        """One step: "landed" and its undo entry; "unsure" (written, or maybe written, and not
        confirmed: a read settles it); or "failed", with nothing written. `guard`: a retry's
        version, the one nothing landed on, which the fresh read must find before it writes."""
        self._recording = (pid, plan, rec, guard)
        try:
            entry = step.run()
        except Stopped as s:
            entry, stopped = s.undo or (rec["entry"] if rec["status"] == "trying" else None), s
            if entry is None and guard is not None and s.kind in ("changed", "gone"):
                entry = rec.get("entry")       # a retry that finds it moved on: a read says whose change
        except Refuse as e:
            entry, stopped = None, Stopped("failed", words=str(e))
        except (ValueError, KeyError, TypeError, ical.Unreadable) as e:
            entry, stopped = None, Stopped("failed", words=str(e) if isinstance(e, ics_edit.Cant)
                                           else "I couldn't read that event")
        else:
            stopped = None
        finally:
            self._recording = None
        if stopped is not None and (entry is None or stopped.kind not in unsure_if):
            # Turned down: a server's "no" to a write means it never landed (caldav.py,
            # google_cal.py), and a step stopped before its write never sent one.
            rec.update(status="failed", entry=None, kind=stopped.kind, words=stopped.words)
            self._save_plan(pid, plan)
            return "failed", None, stopped
        full = {**entry, "removed": [list(x[:3]) for x in step.removed], **({"rows": step.rows} if step.rows else {})}
        # Its records are kept as if it landed even while unsure, so a read from before the write
        # can't undo it; a read that finds it didn't land puts them back (_unapply).
        rec.update(status="landed" if stopped is None else "unsure", entry=full, kind="", words="", applied=True)
        with self.ledger.tx() as db:     # a crash after this still knows what to read or undo
            self._save_plan(pid, plan, db)
            self._note_removed(db, step.removed)
            self._keep_rows(db, step.rows)
            if stopped is None:
                undo = json.loads(db.execute("SELECT undo_json FROM calendar_changes WHERE proposal_id=?",
                                             (pid,)).fetchone()[0] or "[]")
                db.execute("UPDATE calendar_changes SET undo_json=? WHERE proposal_id=?",
                           (json.dumps(undo + [full]), pid))
        return ("landed", full, None) if stopped is None else ("unsure", full, stopped)

    def _wait_for_read(self, pid: str, plan: dict) -> None:
        now = iso(self.ledger.now())
        plan.update(since=plan.get("since") or now, read_at=now)
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET state='settling', updated_at=? WHERE proposal_id=?",
                       (now, pid))
            self._save_plan(pid, plan, db)

    def _plan_all(self, params: dict, pid: str) -> tuple[list[Part], list[str]]:
        """Every change he asked for, found and decided before anything is written. One event
        named twice for the same thing is one part (Nov 11: a card moved PT on Gmail and its copy
        on Family as two lines); named for two different things, it's unclear."""
        parts: list[Part] = []
        notes: list[str] = []
        for index, change in enumerate(params["changes"]):
            more, said_here = self._plan(change, f"{pid}:{index}")
            notes += said_here
            for part in more:
                same = next((x for x in parts if part.key and x.key and x.key[0] & part.key[0]), None)
                if same is None:
                    parts.append(part)
                elif same.key != part.key:
                    raise Unclear(f"you asked for two different changes to one event: "
                                  f"{render.plain(same.will)}, and {render.plain(part.will)}", "Which one?")
        return parts, notes

    def _note_removed(self, db, removed: list) -> None:
        """(calendar, uid, instance, title, day): a day as a date, or as its record keeps it."""
        now = iso(self.ledger.now())
        for calendar, uid, instance, title, day in removed:
            db.execute("INSERT OR REPLACE INTO calendar_removed(calendar, uid, instance, title,"
                       " day, removed_at, told_at) VALUES(?,?,?,?,?,?,NULL)",
                       (calendar, uid, instance, title, day if isinstance(day, str) else day.isoformat(), now))

    # -- this add-on's own records of a copy or block it changed for him -----------------------
    _ROW_TABLES = ("family_copies", "family_gmail")

    def _keep_rows(self, db, rows: list[dict]) -> None:
        """Kept true in the same transaction as the write's record, so the copy's or block's own
        sync sees this add-on's work, not someone's edit, and doesn't put it back."""
        now = iso(self.ledger.now())
        for r in rows:
            if r["table"] not in self._ROW_TABLES:
                continue
            cols = ", ".join(f"{k}=?" for k in r["set"])
            db.execute(f"UPDATE {r['table']} SET {cols}, updated_at=? WHERE key=? AND state=?",
                       (*r["set"].values(), now, r["key"], r["was"].get("state", "live")))
            if r.get("hold"):
                family_copy.hold(self.ledger, r["key"], *r["hold"], db=db)

    def _undo_rows(self, db, rows: list[dict]) -> None:
        """As they were before the change, if nothing has moved them on since."""
        now = iso(self.ledger.now())
        for r in rows:
            if r["table"] not in self._ROW_TABLES:
                continue
            cols = ", ".join(f"{k}=?" for k in r["was"])
            states = r.get("undo_from") or [r["set"].get("state", "live")]
            db.execute(f"UPDATE {r['table']} SET {cols}, updated_at=? WHERE key=? AND state IN "
                       f"({','.join('?' * len(states))})", (*r["was"].values(), now, r["key"], *states))
            if r.get("hold"):                    # a read from before the undo shows the change
                family_copy.hold(self.ledger, r["key"], r["set"]["start"], r["set"]["end"], db=db)
            if r.get("gone"):                    # a read from before the undo shows it gone
                family_copy.hold(self.ledger, r["key"], gone=True, db=db)

    def _finish(self, p, results: list, undo: list[dict], notes: list[str]) -> None:
        """One receipt: what was done, and what wasn't, each by name with why. Never "Nothing
        changed" when something did (Nov 11). Only known outcomes come here: one a read hasn't
        settled waits for it (_settle)."""
        failed = [(part, landed, s, at) for part, landed, s, at in results if s is not None]
        done = [part for part, _, s, _ in results if s is None]
        ok = not failed
        kind = "done" if ok else failed[0][2].kind
        with self.ledger.tx() as db:
            now = iso(self.ledger.now())
            db.execute("UPDATE proposals SET state=? WHERE id=?",
                       ("executed" if ok else "failed", p["id"]))
            db.execute("UPDATE calendar_changes SET state=?, undo_state=?, updated_at=? WHERE"
                       " proposal_id=?", (kind, "open" if undo else "none", now, p["id"]))
            self.ledger.transition(p["job_id"], "executed" if ok else "failed", db=db,
                                   receipt=json.dumps({"effect": effects.CALENDAR_CHANGE,
                                                       "steps": len(undo), "outcome": kind,
                                                       "parts": len(results), "parts_done": len(done)}))
            if ok:
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
                self.ledger.event("calendar_change_done", {"steps": len(undo)}, db=db)
                head = "<b>Done.</b>"
            else:
                self.ledger.set_meta(PROBLEM, "Calendar change: the last one didn't finish", db)
                head = ("<b>Only part of that went through.</b>" if done
                        else "<b>That stopped partway.</b>" if any(landed for _, landed, _, _ in failed)
                        else "<b>Not confirmed.</b>" if any(s.kind == "unconfirmed" for _, _, s, _ in failed)
                        else "<b>Nothing changed.</b>")
            lines = [head] + [part.done for part in done]
            for part, landed, s, at in failed:
                why = _safe(s.words or WORDS.get(s.kind) or "the calendar refused it")
                went = " and ".join(dict.fromkeys(x.what for x in landed))
                # Writes on one calendar (two series of one title, say) are part of it there,
                # never "on Family, not on Family".
                if s.kind == "unconfirmed":      # reads never could tell, and they've stopped
                    lines.append(f"Not confirmed: {part.will}. " + (
                        f"Part of it went through on {at.what}; reads couldn't tell whether the rest did"
                        if landed and went == at.what else
                        f"It went through on {went}; reads couldn't tell whether it did on {at.what}"
                        if landed else "Reads couldn't tell whether it went through")
                        + f", and {why}, so I've stopped reading it.")
                elif s.kind == "put_back" and s.words == at.what:    # part of it landed, and was put back
                    lines.append(f"Not done: {part.will}. Only part of it went through on {at.what}, so I "
                                 "put that part back as it was.")
                elif s.kind == "put_back":
                    lines.append(f"Not done: {part.will}. It went through on {s.words}, not on "
                                 f"{at.what}, so I put it back as it was on {s.words}.")
                elif landed and went == at.what:
                    lines.append(f"Partly done: {part.will}. Only part of it went through on {at.what}, "
                                 f"because {why}.")
                elif landed:
                    lines.append(f"Partly done: {part.will}. It went through on {went}, not on {at.what}, "
                                 f"because {why}.")
                else:
                    lines.append(f"Not done: {part.will}, because {why}.")
            lines += [_safe(x) for x in notes]
            buttons, binds = self._undo_button(db, p["id"]) if undo else (None, None)
            self._say(db, self.chat_id, p["job_id"], "\n".join(lines), buttons=buttons, binds=binds)
        log.info("calendar change job %s: %s, %d of %d part(s) done, %d write(s)",
                 render.short(p["job_id"]), kind, len(done), len(results), len(undo))

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
                                 bool(occ.instance), occ.start, item, bool(occ.attendees), "family", occ.end))
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
                             *self._span(first, last), bool(e.get("recurringEventId")), first, e, invited,
                             "gmail", last))
        return out, 0

    def context_for(self, text: str, now: datetime) -> list[str]:
        """His Gmail events today and tomorrow, and others whose names share a word with his
        message, so the model knows what "PT" is today and "again" reads as the last one's day,
        time and place. A word of two letters counts ("PT"), in either form ("physical therapy").
        Harness's own blocks are marked as its. In a worker; nothing raised."""
        words = {w for w in title_words(_CLOCK.sub(" ", text)) if len(w) > 1} - _CONTEXT_SKIP - _FILLER
        if self.google is None or not self.google.configured() or not self.address():
            return []
        try:
            events = self.google.events_between(self.address(), now - CONTEXT_BACK, now + CONTEXT_AHEAD)
        except Exception as e:                     # a lookup is a help, never a stop
            log.warning("calendar context failed: %s", type(e).__name__)
            return []
        zone = ZoneInfo(self.tz)
        today = now.astimezone(zone).date()
        near, named = [], []
        for e in events or []:
            title = e.get("summary") or ""
            when = self._gmail_when(e.get("start"))
            end = self._gmail_when(e.get("end"))
            if e.get("status") == "cancelled" or when is None or end is None:
                continue
            day = when.astimezone(zone).date() if isinstance(when, datetime) else when
            soon = today <= day <= today + timedelta(days=1)
            if not soon and not (words & title_words(title) and isinstance(when, datetime)):
                continue
            if isinstance(when, datetime) and isinstance(end, datetime):
                at = render.family_when(when.isoformat(), end.isoformat(), self.tz)
                key = when.astimezone(timezone.utc)
            else:
                at = f"{_day_words(when)}, all day"
                key = datetime.combine(when, datetime.min.time(), zone).astimezone(timezone.utc)
            place = f" at {e['location'].split(',')[0]}" if e.get("location") else ""
            series = ", repeats" if e.get("recurringEventId") else ""
            ours = " (a block Harness made)" if google_cal._ours(e) else ""
            (near if soon else named).append((key, f"{at}: {_safe(title)}{place}{series}{ours}"))
        named = sorted(named)[-CONTEXT_MAX:]
        return [line for _, line in sorted(near)[-CONTEXT_NEAR:] + named]

    def _gmail_address(self) -> str:
        if self.google is None or not self.google.configured():
            raise Refuse("the Google key isn't set on the Harness page")
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

    def _readable(self, calendar: str) -> bool:
        """Set up to be read at all: a calendar that isn't set up is none, not an unread one."""
        if calendar == "family":
            return self.client is not None and self.client.configured()
        return self.google is not None and self.google.configured() and bool(self.address())

    def _pool(self, named: str, days: list[date]) -> tuple[list[Found], list[Found], int, list[str]]:
        """What's on those days: first what the named calendar shows, with Harness's copies on
        Family counted as the Gmail events they copy and Harness's blocks on Gmail counted on
        either; then the rest of the other calendar, looked at only if nothing first fits."""
        found, unreadable, unread = [], 0, []
        for calendar in (named, "family" if named == "gmail" else "gmail"):
            if calendar != named and not self._readable(calendar):
                continue
            try:
                more, bad = self._read(calendar, days)
            except Refuse:
                if calendar == named:
                    raise
                unread.append("Family" if calendar == "family" else "your Gmail calendar")
                continue
            found += more
            unreadable += bad
        gmail, family = self._fold(found)
        if named == "gmail":
            return gmail + [f for f in family if f.copy_of], [f for f in family if not f.copy_of], \
                unreadable, unread
        mine = [g for g in gmail if g.copies or g.taken or g.block]
        return family + mine, [g for g in gmail if g not in mine], unreadable, unread

    def _fold(self, found: list[Found]) -> tuple[list[Found], list[Found]]:
        """(Gmail events, Family events). A copy Harness keeps of a Gmail event is part of it,
        so "PT" isn't two events. A copy whose Gmail event isn't there stays on its own, marked."""
        sources: dict[str, Found] = {}
        gmail = [f for f in found if f.calendar == "gmail"]
        for g in gmail:
            g.block = self._block_key(g)
            key = self._copy_key(g)
            if key:
                sources.setdefault(key, g)
        rows = self.ledger.db.execute("SELECT key, uid, href, hand, state FROM family_copies").fetchall()
        made = {r["uid"]: r for r in rows if not r["hand"]}
        taken = {caldav.href_path(r["href"]): r for r in rows if r["hand"] and r["href"] and r["state"] == "live"}
        family = []
        for f in (f for f in found if f.calendar == "family"):
            row = made.get(f.series) or taken.get(caldav.href_path(getattr(f.raw, "href", "") or ""))
            if row is None:
                family.append(f)
                continue
            f.copy_of = row["key"]
            source = sources.get(row["key"]) if row["state"] == "live" else None
            if source is None:
                family.append(f)               # its Gmail event isn't there: never changed alone
            elif row["hand"]:
                source.taken.append(f)         # his own, which its sync keeps true: it follows
            else:
                source.copies.append(f)
        return gmail, family

    def _copy_key(self, g: Found) -> str:
        """The key family_copy.py gives the copy of this Gmail event: how the feed names it."""
        try:
            occ = google_cal._occurrence(g.raw, self.address() or "", "")
        except (KeyError, ValueError, TypeError, AttributeError):
            return ""
        return family_copy._key(occ) if occ is not None else ""

    def _block_key(self, g: Found) -> str:
        """A block this add-on made on his Gmail calendar (family_gmail.py): its key, or ""."""
        if not google_cal._ours(g.raw):
            return ""
        row = self.ledger.db.execute("SELECT key FROM family_gmail WHERE event_id=?",
                                     (g.raw.get("id"),)).fetchone()
        return row["key"] if row is not None else "ours"

    def _fits(self, asked: str, f: Found) -> int:
        """His words against the event, and against its copies: "Alex - PT" is that PT too."""
        return max(fit(asked, t) for t in [f.title, *(c.title for c in f.copies + f.taken)])

    def _at(self, f: Found, times) -> bool:
        """At a clock time he gave: 8:00 is the morning's or the evening's, unless he said."""
        if not isinstance(f.start, datetime):
            return False
        t = f.start.astimezone(ZoneInfo(self.tz))
        for hour, minute, half in times:
            hours = {hour % 12 + (12 if half == "p" else 0)} if half else {hour % 12, hour % 12 + 12}
            if t.hour in hours and t.minute == minute:
                return True
        return False

    def _resolve(self, asked: str, days: list[date], first: list[Found], rest: list[Found],
                 unreadable: int, unread: list[str], named: str = "") -> tuple[list[Found], int]:
        """The one event he named, on the days he named: a School Board Meeting next month doesn't
        make "school" on Monday unclear. His words in a title, or its usual long form, are how
        anyone talks about it. A real event, on either calendar, comes before a block of Harness's
        unless his words name the run ("no school" is the School Day, "no drop-off" the drop-off).
        When different events fit, the whole of a name of two words or more beats part of one
        ("School Day" isn't "School Day Pictures"); a one-word name is asked, always ("PT" could be
        the PT at 4:00 or the PT at the clinic). None, two that fit alike, or one only on the
        calendar the model didn't name: he's asked, by name."""
        want, times = said(asked)

        def scored(pool: list[Found]) -> list[tuple[int, Found]]:
            on = [f for f in pool if any(f.first <= d <= f.last for d in days)]
            out = [(self._fits(asked, f), f) for f in on]
            return [(score, f) for score, f in out if score and (not times or self._at(f, times))]
        pools = [scored(first), scored(rest)]
        if not want & _RUN_WORDS:
            real = [[x for x in pool if not x[1].block] for pool in pools]
            if any(real):
                pools = real
        for n, found in enumerate(pools):
            if not found:
                continue
            best = max(score for score, _ in found)
            if len({title_words(f.title) for _, f in found}) > 1:
                top = [f for score, f in found if score == best]
                if best != EXACT or len(want) < 2 or len({title_words(f.title) for f in top}) > 1:
                    raise self._several(asked, days, [f for _, f in found])
                found = [(best, f) for f in top]
            chosen = [f for _, f in found]
            if n == 1:
                where = "Family" if named == "family" else "your Gmail calendar"
                when = render.day_words(days[0], self._today())
                raise Unclear(f"{asked} isn't on {where} {when}, and {self._shown(chosen[0])} is",
                              "Did you mean that one?")
            return chosen, best
        raise self._missing(asked, days, first + rest, unreadable, unread)

    def _hits(self, named: list[Found], day: date, asked: str = "") -> list[Found]:
        hits = [f for f in named if f.first <= day <= f.last]
        if len({(f.calendar, f.series) for f in hits}) > 1:
            raise self._several(asked or hits[0].title, [day], hits)
        return hits

    def _guard(self, f: Found) -> None:
        if f.invited:
            raise Refuse(f"{f.title} has invitees, and changing it could message them")
        if f.copy_of and f.calendar == "family":
            raise Refuse(f"{f.title} on {_day_words(f.first)} is Harness's copy of a Gmail event I "
                         "can't find that day, so I left it. Change the event on Gmail, and the copy follows")

    def _part_guard(self, asked: str, days: list[date], chosen: list[Found], best: int) -> None:
        """His words are only part of a one-off's name, and around that day something fits them
        better, or repeats under them: "no school Tuesday", when school is Mondays and Wednesdays,
        isn't School Pictures that Tuesday, and "move PT tomorrow" isn't tomorrow's PT insurance
        call when the PT is today. Asked, not guessed (the Nov 5 lesson), on either calendar, for
        a move as well as a removal."""
        if best >= HEAD or any(f.repeats or f.block for f in chosen):
            return
        around: list[Found] = []
        for calendar in sorted({f.calendar for f in chosen}):
            try:
                more, _ = self._read(calendar, [min(days) - timedelta(days=7), max(days) + timedelta(days=7)])
            except Refuse:
                raise Refuse(f"I couldn't read the days around it to tell which {asked} you mean") from None
            around += more
        rivals = [f for f in around if not any(f.first <= d <= f.last for d in days)
                  and ((f.repeats and fit(asked, f.title)) or fit(asked, f.title) >= HEAD)]
        if rivals:
            other = min(rivals, key=lambda f: abs((f.first - days[0]).days))
            today = self._today()
            raise Unclear(f"{other.title} is {render.day_words(other.first, today)}, and {chosen[0].title} is "
                          f"{render.day_words(days[0], today)}", "Which did you mean?")

    def _shown(self, f: Found) -> str:
        """An event as he'd name it, plain: a block of Harness's by what it's for, the rest by title."""
        name = block_name(f.title) if f.block else f.title
        if isinstance(f.start, datetime):
            name += f" at {render.clock_words(f.start.astimezone(ZoneInfo(self.tz)))}"
        where = "" if f.block else " (Gmail and Family)" if f.copies else f" ({f.calendar.title()})"
        return name + where

    def _missing(self, asked: str, days: list[date], found: list[Found], unreadable: int,
                 unread: list[str] = ()) -> Unclear:
        day = days[0]
        on = sorted((f for f in found if f.first <= day <= f.last), key=self._order)
        when = render.day_words(day, self._today())
        words = (f"I can't find {asked} {when}. That day has: "
                 f"{', '.join(self._shown(f) for f in on) or 'nothing'}")
        if unreadable:
            words += ", and something on that calendar I can't read"
        if unread:
            words += f". I couldn't read {' or '.join(unread)}, so it may be there"
        return Unclear(words, "Which did you mean?" if on else "")

    def _several(self, asked: str, days: list[date], events: list[Found]) -> Unclear:
        when = render.day_words(days[0], self._today()) if len(days) == 1 else f"on {_list(days)}"
        named = ", ".join(self._shown(f) for f in sorted(events, key=self._order))
        return Unclear(f"more than one event {when} fits {asked}: {named}", "Which one?")

    def _order(self, f: Found):
        start = f.start if isinstance(f.start, datetime) else \
            datetime.combine(f.start, datetime.min.time(), ZoneInfo(self.tz))
        return start.astimezone(timezone.utc), f.title

    def _one_title(self, asked: str, titles: list[str]) -> str:
        if len({title_words(t) for t in titles}) > 1:
            raise Unclear(f"more than one event fits {asked}: {', '.join(titles)}", "Which one?")
        return titles[0]

    # -- what he sees: his words for it, times as he reads them --------------------------------
    def _today(self) -> date:
        return self.ledger.now().astimezone(ZoneInfo(self.tz)).date()

    def _name(self, asked: str, f: Found) -> str:
        """What to call it to him (Nov 11: "Move PT to 11:30 to 12:30 today"): a block of
        Harness's by what it's for; an event by its own title, or the part before its dash when
        his words are exactly that ("PT" for "PT - Clinic"), so a different event that only shares
        his word is never shown under his word. Made safe."""
        if f.block:
            return _safe(block_name(f.title))
        head = _event_head(f.title)
        return _safe(head if fit(asked, head) == EXACT else f.title)

    def _where(self, f: Found, copies: bool = False) -> str:
        if f.block:
            return ""
        if f.calendar == "gmail":
            return " (Gmail and Family)" if copies else " (Gmail)"
        return " (Family)"

    def _at_words(self, start, end) -> str:
        """11:30 to 12:30 today; 9:00 to 10:00 on Fri Nov 20; an all-day stretch by its days."""
        today = self._today()
        if not isinstance(start, datetime):
            last = end - timedelta(days=1)
            return (render.day_words(start, today) if last == start
                    else f"{render.date_words(start, today)} through {render.date_words(last, today)}")
        zone = ZoneInfo(self.tz)
        s, e = start.astimezone(zone), end.astimezone(zone)
        if s.date() == e.date():
            return f"{render.span_words(s, e)} {render.day_words(s.date(), today)}"
        return (f"{render.date_words(s.date(), today)}, {render.clock_words(s, suffix=True)} to "
                f"{render.date_words(e.date(), today)}, {render.clock_words(e, suffix=True)}")

    def _move_words(self, name: str, f: Found, start, end, where: str) -> tuple[str, str]:
        today = self._today()
        new_day = start.astimezone(ZoneInfo(self.tz)).date() if isinstance(start, datetime) else start
        text = f"{name} to {self._at_words(start, end)}"
        if new_day != f.first:
            owner = render.day_owner(f.first, today)
            text = (f"{owner} {text}" if owner
                    else f"{name} from {render.date_words(f.first, today)} to {self._at_words(start, end)}")
        return f"Move {text}{where}", f"Moved {text}{where}"

    def _remove_words(self, name: str, picked: list[Found], days: list[date], where: str) -> tuple[str, str]:
        """Take off today's 8:00 drop-off; Take School Day off Nov 23, Nov 25."""
        today = self._today()
        if len(picked) == 1:
            f = picked[0]
            if isinstance(f.start, datetime):
                clock = render.clock_words(f.start.astimezone(ZoneInfo(self.tz)))
                owner = render.day_owner(f.first, today)
                text = (f"{owner} {clock} {name}" if owner
                        else f"the {clock} {name} on {render.date_words(f.first, today)}")
            elif f.first == f.last:
                text = f"{name} {render.day_words(f.first, today)}"
            else:
                text = f"{name}, {render.date_words(f.first, today)} to {render.date_words(f.last, today)}"
            return f"Take off {text}{where}", f"Took off {text}{where}"
        shown = sorted({f.first for f in picked})
        return f"Take {name} off {_list(shown)}{where}", f"Took {name} off {_list(shown)}{where}"

    # -- working out what to write -------------------------------------------------------------
    def _plan(self, c: dict, key: str) -> tuple[list[Part], list[str]]:
        calendar, op = c["calendar"], c["op"]
        if op == "rule":
            step = self._rule(c)
            return [Part(step.label, step.label, [step])], []
        if calendar == "gmail":
            self._gmail_address()
        if op in ("add", "add_series"):
            return [self._add_part(c, key)], []
        days = _dates(c["dates"])
        self._check_days(days)
        if op == "end_series":
            found, unreadable = self._read(calendar, days, END_AHEAD)
            return self._plan_end(calendar, c["title"], days[0], c["days"], found, unreadable)
        first, rest, unreadable, unread = self._pool(calendar, days)
        chosen, best = self._resolve(c["title"], days, first, rest, unreadable, unread, calendar)
        if best == PART:
            self._part_guard(c["title"], days, chosen, best)
        if op == "remove":
            return self._plan_remove(c["title"], days, chosen, first + rest, unreadable, unread)
        hits = self._hits(chosen, days[0], c["title"])
        if not hits:
            raise self._missing(c["title"], days, first + rest, unreadable, unread)
        hit = hits[0]
        self._guard(hit)
        if hit.repeats and hit.first != days[0]:
            raise Refuse(f"that day of {hit.title} starts on {_day_words(hit.first)}. Name that day")
        start, end, _ = self._new_times(c)
        if hit.calendar == "gmail":
            steps = [self._gmail_move(hit, start, end)] + [self._copy_move(x, start, end) for x in hit.copies]
            if hit.block and hit.block != "ours":
                # A block he moves is his now (family_gmail.py would say so a read later); Undo
                # hands it back to its sync, so it follows school again.
                steps[0].rows = [{"table": "family_gmail", "key": hit.block, "set": {"state": "hands_off"},
                                  "was": {"state": "live", "missing": 0}}]
        else:
            steps = [self._family_move(hit, start, end)]
        name = self._name(c["title"], hit)
        will, done = self._move_words(name, hit, start, end, self._where(hit, bool(hit.copies)))
        targets = frozenset((f.calendar, f.series, f.instance) for f in [hit, *hit.copies])
        part = Part(will, done, steps, (targets, ("move", _moment(start), _moment(end))), name=name)
        if isinstance(start, datetime) and isinstance(hit.start, datetime) and isinstance(hit.end, datetime) \
                and end - start != hit.end - hit.start:
            part.length = (hit.end - hit.start, end - start, end, name)
        return [part], []

    def _plan_remove(self, asked: str, days: list[date], chosen: list[Found], found: list[Found],
                     unreadable: int, unread: list[str]) -> tuple[list[Part], list[str]]:
        picked, absent = {}, []
        for day in days:
            hits = self._hits(chosen, day, asked)
            if not hits:
                absent.append(day)
            for f in hits:
                self._guard(f)
                covered = [f.first + timedelta(days=i) for i in range((f.last - f.first).days + 1)]
                if not set(covered) <= set(days):
                    raise Refuse(f"{f.title} runs {_day_words(f.first)} to {_day_words(f.last)}, so "
                                 "that would take off all of it. Name all its days to remove it, or "
                                 "give me its new dates")
                picked[(f.calendar, f.series, f.instance)] = f
        if not picked:
            raise self._missing(asked, [absent[0]], found, unreadable, unread)
        notes = []
        if absent:
            notes.append(f"I didn't find it on {_list(absent)}, so nothing changed there.")
        # One part per event (a Gmail event with its copy, or a Family series's days, which are one
        # write), so a part that fails names only itself, and the others still go.
        parts: list[tuple[date, Part]] = []
        series: dict[str, list[Found]] = {}
        for f in picked.values():
            if f.calendar == "family" and f.repeats:
                series.setdefault(f.series, []).append(f)
                continue
            if f.calendar == "gmail":
                steps = [self._gmail_remove(f)] + [self._copy_remove(x) for x in f.copies]
            else:
                steps = [self._family_remove_one(f)]
            will, done = self._remove_words(self._name(asked, f), [f], [f.first], self._where(f, bool(f.copies)))
            targets = frozenset((x.calendar, x.series, x.instance) for x in [f, *f.copies])
            parts.append((f.first, Part(will, done, steps, (targets, ("remove",)), removes=1,
                                        name=self._name(asked, f))))
        for group in series.values():
            will, done = self._remove_words(self._name(asked, group[0]), group, [g.first for g in group],
                                            " (Family)")
            targets = frozenset(("family", g.series, g.instance) for g in group)
            parts.append((min(g.first for g in group),
                          Part(will, done, [self._family_remove_days(group)], (targets, ("remove",)),
                               removes=len(group), name=self._name(asked, group[0]))))
        return [part for _, part in sorted(parts, key=lambda x: x[0])], notes

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
            if title_words(f.title) == title_words(title):
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
        first = next(iter(series.values()))
        name = self._name(asked, first)
        if unreadable:
            # One more read before it's said: an event that didn't parse once can on the next.
            try:
                unreadable = self._read(calendar, [day], END_AHEAD)[1]
            except Refuse:
                pass
        # What's still unreadable is a fact for his decision, on the card and in the receipt.
        fact = (f"something on {'Family' if calendar == 'family' else 'your Gmail calendar'} can't be "
                f"read, so another series called {render.plain(name)} may keep going.") if unreadable else ""
        text = (f"{name} from {render.date_words(day, self._today())} on"
                f"{self._where(first)}")
        targets = frozenset((f.calendar, f.series, "*") for f in series.values())
        return [Part(f"End {text}", f"Ended {text}", steps, (targets, ("end", day.isoformat())),
                     ends=name, name=name, warns=[fact] if fact else [])], \
            [fact[0].upper() + fact[1:]] if fact else []

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
        every = int(c.get("every") or 1)
        rule = f"FREQ=WEEKLY;BYDAY={c['days']}" + (f";INTERVAL={every}" if every > 1 else "")
        if not c["until"]:
            return start, end, rule                # it goes on until he ends it
        until = date.fromisoformat(c["until"])
        self._check_days([until])
        cut = datetime(until.year, until.month, until.day, 23, 59, 59, tzinfo=ZoneInfo(self.tz))
        return start, end, f"{rule};UNTIL={cut.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"

    def _when_words(self, start, end) -> str:
        """Friday, 9:00 to 10:00; Fri Nov 20, 9:00 to 10:00; Dec 1 to Dec 5. Never an ISO stamp."""
        if not isinstance(start, datetime):
            last = end - timedelta(days=1)
            return _day_words(start) if last == start else f"{_day_words(start)} to {_day_words(last)}"
        zone = ZoneInfo(self.tz)
        s, e = start.astimezone(zone), end.astimezone(zone)
        if s.date() != e.date():
            return self._at_words(start, end)
        return f"{render.day_words(s.date(), self._today()).removeprefix('on ')}, {render.span_words(s, e)}"

    def _add_part(self, c: dict, key: str) -> Part:
        step = (self._family_add if c["calendar"] == "family" else self._gmail_add)(c, key)
        start, end, _ = self._new_times(c)
        text = f"{_safe(c['title'])}{self._new_words(c, start, end)}"
        where = " (Family)" if c["calendar"] == "family" else " (Gmail)"
        return Part(f"Add {text}{where}", f"Added {text}{where}", [step], name=_safe(c["title"]), adds=True)

    def _new_words(self, c: dict, start, end) -> str:
        if c["op"] == "add_series":
            n = int(c.get("every") or 1)
            every = f"{'other' if n == 2 else str(n) + ' weeks on'} " if n > 1 else ""
            days = ", ".join(_WEEKDAY_WORDS[d] for d in c["days"].split(","))
            head = f" every {every}{days}, starting {self._when_words(start, end)}"
            if not c["until"]:
                return head + ", going on until you end it"
            until = date.fromisoformat(c["until"])
            return f"{head}, through {_day_words(until)}, {until.year}"
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
            entry = {"cal": "rule", "how": "rule", "said": said, "kind": kind,
                     "before": [before.said, before.kind] if before else None}
            self._attempt(entry)
            with self.ledger.tx() as db:
                family_rules.put(self.ledger, said, kind, db)
            return entry
        n = self._rule_reach(said)
        reach = ("" if n is None else " Nothing on Family has those words in the next two months." if n == 0
                 else f" That's {n} event{'' if n == 1 else 's'} on Family in the next two months.")
        return Step(f"From now on, Family events with {_safe(said)} in the name {RULE_WORDS[kind]}.{reach} "
                    "Gmail and work follow within a few minutes.", run, spec={"fn": "rule", "c": c})

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

    def _family_shows(self, check: dict, body: str) -> bool:
        """What the write was for, as a read of the event shows it: the days gone, the series
        ended (by its own rule, not only the next 400 days of it), the occurrence it moved at its
        new time, the new event there. Kept as data, so a read after a restart can ask it too."""
        kind = check["kind"]
        if kind == "days_off":
            days = [date.fromisoformat(d) for d in check["days"]]
            start, end = self._bounds(days, timedelta(days=1))
            return not {o.instance for o in self._occurrences(body, start, end)} & set(check["keys"])
        if kind == "ends":
            day = date.fromisoformat(check["day"])
            start, end = self._bounds([day, day + timedelta(days=400)])
            if any(self._span(o.start, o.end)[0] >= day for o in self._occurrences(body, start, end)):
                return False
            try:
                return ics_edit.ends_by(body, day, self.tz)
            except (ics_edit.Cant, ical.Unreadable):
                return True                                 # a rule this can't read: the 400 days say
        if kind == "starts":
            start, end = _when(check["start"]), _when(check["end"])
            low, high = self._span(start, end)
            moved = self._occurrences(body, *self._bounds([low, high]))
            if "instance" not in check:                     # recorded before 0.23.0 kept which one
                return any(_same_start(o.start, start) for o in moved)
            # The occurrence it moved, by its own key (its RECURRENCE-ID, or "" for a one-off), at
            # its new start and end: not another occurrence that happens to start then.
            return any(o.instance == check["instance"] and (not check.get("uid") or o.uid == check["uid"])
                       and _same_start(o.start, start) and _same_start(o.end, end) for o in moved)
        return bool(ical.parse_calendar(body)[1])           # "there": a new event

    def _family_write(self, href: str, etag: str, before: str, new: str, check: dict) -> dict:
        """The write, then what the calendar holds afterward, not what was sent. An answer that's
        lost, or a read back that fails or doesn't show it, leaves it to a read (_settle)."""
        entry = {"cal": "family", "how": "put", "href": href, "before": before, "after": new,
                 "sent": new, "etag": "", "was": etag, "check": check}
        self._attempt(entry)
        out = self.client.replace(href, etag, new)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status, undo=entry if out.kind == "unknown" else None)
        entry["etag"] = out.etag or ""
        back, body = self.client.fetch(href)
        if back.kind != "ok":
            raise Stopped("unknown", back.status, undo=entry)
        entry["etag"] = back.etag or entry["etag"]
        entry["after"] = body or new        # as the server keeps it, so a later undo can match it
        try:
            shows = self._family_shows(check, body)
        except (ValueError, KeyError, TypeError, ical.Unreadable):
            shows = False                   # written, and its read back can't be placed: a read settles it
        if not shows:
            raise Stopped("unknown", undo=entry)
        return entry

    def _family_remove_days(self, group: list[Found]) -> Step:
        first = group[0]
        href = first.raw.href
        days = [f.first for f in group]
        keys = [f.instance for f in group]
        check = {"kind": "days_off", "keys": keys, "days": [d.isoformat() for d in days]}

        def run() -> dict:
            body, etag = self._family_fetch(href)
            return self._family_write(href, etag, body, ics_edit.remove_days(body, keys, self.tz, self.ledger.now()),
                                      check)
        return Step(f"Family: {_safe(first.title)} off {_list(days)}.", run,
                    [("family", first.series, k, first.title, d) for k, d in zip(keys, days)], what="Family",
                    spec={"fn": "family_remove_days", "found": [_found_json(f) for f in group]})

    def _family_delete(self, href: str, etag: str, body: str) -> dict:
        entry = {"cal": "family", "how": "restore", "href": href, "before": body, "was": etag}
        self._attempt(entry)
        out = self.client.remove_at(href, etag)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status, undo=entry if out.kind == "unknown" else None)
        back, _ = self.client.fetch(href)
        if back.kind != "gone":             # still there, or the read failed: a read settles it
            raise Stopped("unknown", back.status, undo=entry)
        return entry

    def _family_remove_one(self, f: Found) -> Step:
        def run() -> dict:
            body, etag = self._family_fetch(f.raw.href)
            if ics_edit.people(body):
                raise ics_edit.Cant("it has invitees, and changing it could message them")
            return self._family_delete(f.raw.href, etag, body)
        return Step(f"Family: {_safe(f.title)} on {_day_words(f.first)} removed.", run,
                    [("family", f.series, "", f.title, f.first)], what="Family",
                    spec={"fn": "family_remove_one", "found": [_found_json(f)]})

    def _family_end(self, f: Found, day: date) -> Step:
        href = f.raw.href
        check = {"kind": "ends", "day": day.isoformat()}

        def run() -> dict:
            body, etag = self._family_fetch(href)
            new = ics_edit.end_from(body, day, self.tz, self.ledger.now())
            if new is None:
                return self._family_delete(href, etag, body)
            return self._family_write(href, etag, body, new, check)
        return Step(f"Family: {_safe(f.title)} ends, with nothing on or after {_day_words(day)}.", run,
                    [("family", f.series, "*", f.title, day)], what="Family",
                    spec={"fn": "family_end", "found": [_found_json(f)], "day": day.isoformat()})

    def _family_move(self, f: Found, start, end) -> Step:
        href = f.raw.href
        check = {"kind": "starts", "start": _text(start), "end": _text(end), "instance": f.instance,
                 "uid": f.series}

        def run() -> dict:
            body, etag = self._family_fetch(href)
            now = self.ledger.now()
            new = (ics_edit.move_day(body, f.instance, start, end, self.tz, now) if f.instance
                   else ics_edit.move_one(body, start, end, self.tz, now))
            return self._family_write(href, etag, body, new, check)
        return Step(f"Family: {_safe(f.title)} on {_day_words(f.first)} moved to {self._when_words(start, end)}.",
                    run, what="Family",
                    spec={"fn": "family_move", "found": [_found_json(f)], "start": _text(start), "end": _text(end)})

    def _copy_move(self, f: Found, start, end) -> Step:
        """Harness's copy of a Gmail event, moved with it in the same change (Nov 11: copies follow),
        its record kept true, so its own sync neither takes the move for someone's edit nor moves it
        back from a read taken before the change."""
        step = self._family_move(f, start, end)
        step.what = "the Family copy"
        row = self.ledger.db.execute("SELECT start, end FROM family_copies WHERE key=? AND state='live'",
                                     (f.copy_of,)).fetchone()
        if row is not None:
            step.rows = [{"table": "family_copies", "key": f.copy_of,
                          "set": {"start": _text(start), "end": _text(end), "missing": 0},
                          "was": {"start": row["start"], "end": row["end"]},
                          "hold": [row["start"], row["end"]]}]
        return step

    def _copy_remove(self, f: Found) -> Step:
        """The copy goes with its Gmail event, and isn't put back while that's off."""
        step = self._family_remove_one(f)
        step.what, step.removed = "the Family copy", []
        step.rows = [{"table": "family_copies", "key": f.copy_of, "set": {"state": "asked_off"},
                      "was": {"state": "live", "missing": 0}, "undo_from": ["asked_off", "cancelled"],
                      "gone": True}]
        return step

    def _family_add(self, c: dict, key: str) -> Step:
        start, end, rule = self._new_times(c)
        uid = self._uid(key, "hm-")
        href = self.client.href_for(uid)
        ics = ics_edit.build(uid, c["title"], start, end, c["location"], rule, self.tz, self.ledger.now())

        def run() -> dict:
            # A fixed address, written only where nothing is (If-None-Match), so a second try can
            # never make a second event.
            entry = {"cal": "family", "how": "delete", "href": href, "after": ics, "sent": ics, "etag": "",
                     "check": {"kind": "there"}}
            self._attempt(entry)
            out = self.client.put_new(href, ics)
            if out.kind != "ok":
                raise Stopped(out.kind, out.status, undo=entry if out.kind == "unknown" else None)
            entry["etag"] = out.etag or ""
            back, body = self.client.fetch(href)
            if back.kind != "ok":
                raise Stopped("unknown", back.status, undo=entry)
            entry["etag"] = back.etag or entry["etag"]
            entry["after"] = body or ics
            if not ical.parse_calendar(body)[1]:
                raise Stopped("unknown", undo=entry)
            return entry
        return Step(f"Family: {_safe(c['title'])} added{self._new_words(c, start, end)}.", run, what="Family",
                    spec={"fn": "family_add", "c": c, "key": key})

    # -- Gmail ---------------------------------------------------------------------------------
    def _gmail_shows(self, check: dict, event: dict) -> bool:
        kind = check["kind"]
        if kind == "starts":                                # a move: its new start and end, not cancelled
            return event.get("status") != "cancelled" \
                and _same_start(self._gmail_when(event.get("start")), _when(check["start"])) \
                and (not check.get("end") or _same_start(self._gmail_when(event.get("end")), _when(check["end"])))
        if kind == "rrule":
            return event.get("recurrence") == check["value"]
        return event.get("status") != "cancelled"           # "there": a new event

    def _gmail_reread(self, address: str, uid: str, entry: dict) -> dict:
        kind, now = self.google.look(address, uid)
        if kind != "ok":
            raise Stopped("unknown", undo=entry)
        entry["etag"] = now.get("etag")
        if not self._gmail_shows(entry["check"], now):
            raise Stopped("unknown", undo=entry)
        return entry

    def _gmail_send(self, out, entry: dict) -> None:
        """A write's answer: "no" means it never landed; a lost one leaves it to a read."""
        if out.kind != "ok":
            raise Stopped(out.kind, out.status, undo=entry if out.kind == "unknown" else None)

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
        entry = {"cal": "gmail", "how": "restore", "id": e["id"], "was": e.get("etag"),
                 "fields": {**{k: e[k] for k in _RESTORED if k in e}, "status": "confirmed"}}
        if e.get("recurringEventId"):
            entry["series"] = e["recurringEventId"]
        self._attempt(entry)
        self._gmail_send(self.google.drop(address, e["id"], e.get("etag")), entry)
        if not self.google.really_gone(address, e["id"]):
            raise Stopped("unknown", undo=entry)
        return entry

    def _gmail_remove(self, f: Found) -> Step:
        def run() -> dict:
            address = self._gmail_address()
            return self._gmail_drop(address, self._gmail_fresh(address, f.raw))
        spec = {"fn": "gmail_remove", "found": [_found_json(f)]}
        if f.block:
            # A block of Harness's (a school run, a drive): his answer, so its sync doesn't put it
            # back; Undo puts it and its record back.
            rows = [{"table": "family_gmail", "key": f.block, "set": {"state": "removed"},
                     "was": {"state": "live", "missing": 0}}] if f.block != "ours" else []
            return Step(f"Gmail: {_safe(block_name(f.title))} on {_day_words(f.first)} removed.", run,
                        what="Gmail", rows=rows, spec=spec)
        return Step(f"Gmail: {_safe(f.title)} on {_day_words(f.first)} removed.", run,
                    [("gmail", f.series, f.instance, f.title, f.first)], what="Gmail", spec=spec)

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
            entry = {"cal": "gmail", "how": "change", "id": series, "fields": {"recurrence": before},
                     "wrote": {"recurrence": after}, "was": master.get("etag"),
                     "check": {"kind": "rrule", "value": after}}
            self._attempt(entry)
            self._gmail_send(self.google.change(address, series, {"recurrence": after}, master.get("etag")), entry)
            return self._gmail_reread(address, series, entry)
        return Step(f"Gmail: {_safe(f.title)} ends, with nothing on or after {_day_words(day)}.", run,
                    [("gmail", series, "*", f.title, day)], what="Gmail",
                    spec={"fn": "gmail_end", "found": [_found_json(f)], "day": day.isoformat()})

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
            entry = {"cal": "gmail", "how": "change", "id": e["id"], "fields": old, "wrote": fields,
                     "was": now.get("etag"), "check": {"kind": "starts", "start": _text(start), "end": _text(end)}}
            self._attempt(entry)
            self._gmail_send(self.google.change(address, e["id"], fields, now.get("etag")), entry)
            return self._gmail_reread(address, e["id"], entry)
        return Step(f"Gmail: {_safe(f.title)} on {_day_words(f.first)} moved to {self._when_words(start, end)}.",
                    run, what="Gmail",
                    spec={"fn": "gmail_move", "found": [_found_json(f)], "start": _text(start), "end": _text(end)})

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
            # Its id is fixed, so a second try can never make a second event. All it wrote is kept,
            # so Undo leaves it alone once he's changed any of it.
            address = self._gmail_address()
            wrote = {"summary": event["summary"], "start": event["start"], "end": event["end"],
                     "location": event.get("location", ""), "recurrence": event.get("recurrence", [])}
            entry = {"cal": "gmail", "how": "drop", "id": uid, "wrote": wrote, "check": {"kind": "there"}}
            self._attempt(entry)
            self._gmail_send(self.google.insert(address, event), entry)
            return self._gmail_reread(address, uid, entry)
        return Step(f"Gmail: {_safe(c['title'])} added{self._new_words(c, start, end)}.", run, what="Gmail",
                    spec={"fn": "gmail_add", "c": c, "key": key})

    # -- an outcome no write confirmed, settled by reading -------------------------------------
    # Safety, in one place. A write whose outcome isn't known is read against two records kept
    # before it was sent: the event as it was, and what the write was for (_attempt). Only its
    # very version counts as nothing landed: the same lines under a new version are someone's
    # write since, left as it is and said so. Only then is it written again, once, through the
    # same step, which reads afresh and writes only if that read finds the same version, guarded
    # by it; any other version, or a write refused for its version, isn't called anyone's edit
    # until a read says whose change it is. A part half done is finished the same way, or else
    # put back through Undo's own checks, and a put-back nobody answered is read before any
    # receipt. Someone else's change is never written over. Adds have fixed ids, so a second try
    # finds the first instead of making another. A read that finds a write landed hands Undo its
    # version only when it reads as what was written, so an edit made before that read is never
    # Undo's to put back over. Nothing here runs while stopped.
    @staticmethod
    def _due(state: dict, now: datetime) -> bool:
        return read_due(state, now)

    def _settle_pending(self) -> None:
        now = self.ledger.now()
        for row in self.ledger.db.execute(
                "SELECT * FROM calendar_changes WHERE state='settling' ORDER BY rowid").fetchall():
            plan = _plan(row)
            if plan.get("parts") and self._due(plan, now):
                self._settle(row, plan)

    def _settle(self, row, plan: dict) -> None:
        """One read pass over a change waiting for one: what landed is told as done, what didn't is
        written once more if nothing changed since, a half-done part is finished or put back, and
        what reads can't tell yet is read again a minute later."""
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (row["proposal_id"],)).fetchone()
        pid, now = row["proposal_id"], self.ledger.now()
        recs = [rec for part in plan["parts"] for rec in part["steps"]]
        for rec in recs:                       # cut short mid-write: read it if it was sent
            if rec["status"] == "trying":
                rec["status"] = "unsure" if rec.get("entry") else "pending"
        unread = False
        for rec in recs:
            if rec["status"] != "unsure":
                continue
            seen, read = self._seen_as(rec["entry"])
            if seen == "unread":
                unread = True
            elif seen == "landed":
                self._landed_by_read(pid, plan, rec, read)
            else:
                # "before": its very version, so nothing landed. "not_landed": the version its own
                # write made, without the change. "gone", or "other": someone's change since.
                rec.update(status="before" if seen == "before" else "failed",
                           kind={"before": "", "not_landed": "", "gone": "gone"}.get(seen, "changed_since"))
                self._unapply(rec)
        if unread:
            self._not_yet(row, plan, now)
            return
        if not plan.get("retried"):
            plan["retried"] = True
            self._save_plan(pid, plan)         # before any write, so a crash can't repeat it
            if self.on():
                for part in plan["parts"]:
                    self._try_rest(pid, plan, part)
            if any(rec["status"] == "unsure" for rec in recs):
                # The second try's answer was lost, or it found the version moved on: read it a
                # minute after it was sent, so a late write shows (_attempt kept when that was).
                plan["read_at"] = plan.get("read_at") or iso(self.ledger.now())
                self._save_plan(pid, plan)
                return
        waiting = False
        for part in plan["parts"]:
            waiting = self._put_back_half(pid, plan, part) == "wait" or waiting
        if waiting:                            # a put-back nobody answered: read before any receipt
            self._not_yet(row, plan, now)
            return
        self._settled(row, p, plan)

    def _landed_by_read(self, pid: str, plan: dict, rec: dict, read: dict) -> None:
        """A write a read found landed: its records are kept true and its Undo recorded, once, in the
        same transaction as the outcome, with what Undo clears again (the days it took off, the copy
        and block records it changed), as the usual path keeps them (_run_step). The event as that
        read found it becomes Undo's own only when it reads as what was written, however the server
        rewrote it (_reads_as_written). One changed since keeps what the entry had, so Undo says it
        was changed since and leaves it."""
        entry = rec["entry"]
        entry["removed"] = [list(x[:3]) for x in rec.get("removed", [])]
        if rec.get("rows"):
            entry["rows"] = rec["rows"]
        if self._reads_as_written(entry, read):
            if read.get("etag"):
                entry["etag"] = read["etag"]
            if entry.get("cal") == "family" and entry.get("how") in ("put", "delete") and read.get("body"):
                entry["after"] = read["body"]
        rec["status"] = "landed"
        with self.ledger.tx() as db:
            if not rec.get("applied"):
                self._note_removed(db, rec.get("removed", []))
                self._keep_rows(db, rec.get("rows", []))
                rec["applied"] = True
            db.execute("UPDATE calendar_changes SET undo_json=? WHERE proposal_id=?",
                       (json.dumps(self._undo_entries(plan)), pid))
            self._save_plan(pid, plan, db)

    def _reads_as_written(self, entry: dict, read: dict) -> bool:
        """What a read found is what the write made, as far as a read can say: on Gmail, every field
        the write gave, an add's too; on Family, what was sent and nothing more, by what it says,
        with the lines servers manage aside, so a server that keeps it its own way still reads as
        written and a note or an alert someone added doesn't (caldav._as_sent). A removal found
        gone, or a rule, has nothing more to compare."""
        if entry.get("cal") == "gmail" and entry.get("how") != "restore":
            return self._as_written(read.get("event") or {}, entry.get("wrote") or {})
        if entry.get("cal") == "family" and entry.get("how") in ("put", "delete"):
            return caldav._as_sent(read.get("body") or "", entry.get("sent") or entry.get("after") or "")
        return True

    @staticmethod
    def _undo_entries(plan: dict) -> list[dict]:
        """What Undo puts back: every write known landed, in the order they were sent."""
        return [r["entry"] for r in sorted((r for part in plan["parts"] for r in part["steps"]
                                            if r["status"] == "landed"), key=lambda r: r.get("seq", 0))]

    def _try_rest(self, pid: str, plan: dict, part: dict) -> None:
        """Write again what didn't land and what never ran, in order, once. Not a part someone
        else changed: that stays as it is, and what landed of it is put back. A write again goes
        only over the version the read found nothing landed on; a version moved on since, or a
        write refused for its version, waits for a read to say whose change it is, as an add that's
        "already there" does (it may be the first try, landed late)."""
        recs = part["steps"]
        if all(r["status"] == "landed" for r in recs) or any(r["status"] == "failed" for r in recs):
            return
        for rec in recs:
            if rec["status"] == "landed":
                continue
            prior = rec.get("entry") if rec["status"] == "before" else None
            try:
                step = self._rebuild(rec)
            except Refuse as why:
                rec.update(status="failed", kind="failed", words=str(why))
                self._save_plan(pid, plan)
                return
            except (ValueError, KeyError, TypeError, AttributeError):
                rec.update(status="failed", kind="failed", words="I couldn't read that event")
                self._save_plan(pid, plan)
                return
            guard = prior.get("was") if prior and "was" in prior else None
            unsure_if = ("unknown", "changed", "gone") + (("exists",) if part.get("adds") else ())
            outcome, _, _ = self._run_step(pid, plan, rec, step, unsure_if, guard=guard)
            if outcome != "landed":
                return

    def _put_back_half(self, pid: str, plan: dict, part: dict) -> str:
        """A part that landed only partly goes back, through Undo's own checks: his approval was
        for all of it, so half of it isn't left standing. "wait": a put-back nobody answered, or
        whose read couldn't tell, is read again (by the same checks, which find it already back,
        or write once more at most) before any receipt; "done" otherwise."""
        recs = part["steps"]
        landed = [r for r in recs if r["status"] == "landed"]
        if not landed or len(landed) == len(recs):
            part.pop("putting_back", None)
            return "done"
        latest: dict[str, str] = {}
        self._putting_back = (pid, plan)
        try:
            for rec in sorted(landed, key=lambda r: r.get("seq", 0), reverse=True):
                result = self._undo_step(rec["entry"], latest)
                if result in ("unknown", "auth", "no_credentials", "mismatch"):
                    part["putting_back"] = True
                    self._save_plan(pid, plan)
                    return "wait"
                if result != "ok":
                    part.pop("putting_back", None)
                    return "done"              # what's left stands, with its Undo
                rec["status"] = "undone"
                with self.ledger.tx() as db:
                    self._undo_rows(db, rec["entry"].get("rows", []))
                    for calendar, uid, instance in rec["entry"].get("removed", []):
                        db.execute("DELETE FROM calendar_removed WHERE calendar=? AND uid=? AND instance=?",
                                   (calendar, uid, instance))
                    self._save_plan(pid, plan, db)
        finally:
            self._putting_back = None
        part.pop("putting_back", None)
        self.touched = True
        part["put_back"] = " and ".join(dict.fromkeys(r["what"] for r in recs if r["status"] == "undone"))
        return "done"

    def _settled(self, row, p, plan: dict) -> None:
        """Every write known: one receipt, the same as a change that was never in doubt."""
        results = []
        for part in plan["parts"]:
            recs = part["steps"]
            steps = [Step(r["label"], lambda: {}, what=r["what"]) for r in recs]
            whole = Part(part["will"], part["done"], steps)
            landed = [s for s, r in zip(steps, recs) if r["status"] == "landed"]
            if len(landed) == len(recs):
                results.append((whole, landed, None, None))
                continue
            i = next(n for n, r in enumerate(recs) if r["status"] not in ("landed", "undone"))
            if part.get("put_back"):
                stopped = Stopped("put_back", words=part["put_back"])
            else:
                stopped = Stopped(recs[i]["kind"] or "not_landed", words=recs[i]["words"])
            results.append((whole, landed, stopped, steps[i]))
        undo = self._undo_entries(plan)
        self.touched = True
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_json=? WHERE proposal_id=?",
                       (json.dumps(undo), row["proposal_id"]))
            self._save_plan(row["proposal_id"], plan, db)
        self._finish(p, results, undo, plan.get("notes", []))

    def _not_yet(self, row, plan: dict, now: datetime) -> None:
        """Reads couldn't tell: read again on the schedule (family_add.read_gap). After several
        over an hour, he hears it isn't confirmed yet, once, and then once more when it's known
        (the receipt). Once the event is over or a week has passed, the receipt says it couldn't be
        confirmed, and the reads stop."""
        plan.update(passes=plan.get("passes", 0) + 1, read_at=iso(now))
        why = gave_up(plan.get("since"), self._over_at(plan), now)
        if why:
            self._unconfirmed(row, plan, why)
            return
        tell = self._still_due(plan, now)
        with self.ledger.tx() as db:
            self._save_plan(row["proposal_id"], plan, db)
            if tell:
                unsure = [part for part in plan["parts"] if part.get("putting_back")
                          or any(r["status"] == "unsure" for r in part["steps"])]
                what = " or ".join(f"{part['name']} {'was added' if part.get('adds') else 'changed'}"
                                   for part in unsure if part.get("name")) or "that change went through"
                self._say(db, self.chat_id, row["job_id"], f"I couldn't confirm yet whether {what}; "
                                                            "I'm still checking.")

    def _unconfirmed(self, row, plan: dict, why: str) -> None:
        """Reads never could tell, and the event is over or a week has passed: the one receipt
        says so, with Undo for what's known to have landed, and nothing is read again."""
        for part in plan["parts"]:
            part.pop("putting_back", None)     # what landed of it stands, with its Undo
            for rec in part["steps"]:
                if rec["status"] == "unsure":
                    rec.update(status="unconfirmed", kind="unconfirmed", words=GAVE_UP_WORDS[why])
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (row["proposal_id"],)).fetchone()
        self._settled(row, p, plan)

    def _over_at(self, plan: dict, every: bool = False) -> datetime | None:
        """When what's still being read about is over (every event the change touched, for an undo):
        the latest end any of them has. None when one goes on (a series, a rule)."""
        ends = []
        for part in plan.get("parts", []):
            if not every and not part.get("putting_back") \
                    and not any(r["status"] == "unsure" for r in part["steps"]):
                continue
            for rec in part["steps"]:
                end = self._ends(rec)
                if end is None:
                    return None
                ends.append(end)
        return max(ends) if ends else None

    def _ends(self, rec: dict) -> datetime | None:
        """When the event a write is about is over, as its record says: None for one that goes on
        (a series, a series ended, a rule)."""
        spec = rec.get("spec") or {}
        fn = spec.get("fn", "")
        if fn in ("rule", "family_end", "gmail_end"):
            return None
        times: list = []
        c = spec.get("c") or {}
        if c.get("op") == "add_series":
            if not c.get("until"):
                return None
            times.append(date.fromisoformat(c["until"]))
        elif c.get("end"):
            times.append(_when(c["end"]))
        for f in spec.get("found", []):
            times.append(_when(f["end"]) if f.get("end") else date.fromisoformat(f["last"]))
        if spec.get("end"):
            times.append(_when(spec["end"]))
        if not times:
            return None
        zone = ZoneInfo(self.tz)
        return max(t if isinstance(t, datetime) else datetime(t.year, t.month, t.day, tzinfo=zone)
                   + timedelta(days=1) for t in times)

    @staticmethod
    def _still_due(state: dict, now: datetime) -> bool:
        """The one "still checking" line: reads have failed several times, over an hour."""
        if state.get("told") or state.get("passes", 0) < STILL_CHECKING_PASSES:
            return False
        since = datetime.fromisoformat(state["since"]) if state.get("since") else now
        if now - since < STILL_CHECKING_AFTER:
            return False
        state["told"] = True
        return True

    def _unapply(self, rec: dict) -> None:
        """A write kept in the records as if it landed, read and found not to have: they go back."""
        if not rec.get("applied"):
            return
        with self.ledger.tx() as db:
            self._undo_rows(db, rec["entry"].get("rows", []))
            for calendar, uid, instance in rec["entry"].get("removed", []):
                db.execute("DELETE FROM calendar_removed WHERE calendar=? AND uid=? AND instance=?",
                           (calendar, uid, instance))
        rec["applied"] = False

    def _rebuild(self, rec: dict) -> Step:
        """A step again from its record, after a restart: the same write, reading afresh."""
        spec = rec["spec"]
        found = [_found_back(x) for x in spec.get("found", [])]
        fn = spec["fn"]
        if fn == "family_remove_days":
            step = self._family_remove_days(found)
        elif fn == "family_remove_one":
            step = self._family_remove_one(found[0])
        elif fn == "family_end":
            step = self._family_end(found[0], date.fromisoformat(spec["day"]))
        elif fn == "family_move":
            step = self._family_move(found[0], _when(spec["start"]), _when(spec["end"]))
        elif fn == "family_add":
            step = self._family_add(spec["c"], spec["key"])
        elif fn == "gmail_remove":
            step = self._gmail_remove(found[0])
        elif fn == "gmail_end":
            step = self._gmail_end(found[0], date.fromisoformat(spec["day"]))
        elif fn == "gmail_move":
            step = self._gmail_move(found[0], _when(spec["start"]), _when(spec["end"]))
        elif fn == "gmail_add":
            step = self._gmail_add(spec["c"], spec["key"])
        elif fn == "rule":
            step = self._rule(spec["c"])
        else:
            raise ValueError(f"no step called {fn}")
        step.what, step.rows = rec["what"], rec["rows"]
        step.removed = [(c, u, i, t, date.fromisoformat(d)) for c, u, i, t, d in rec["removed"]]
        return step

    def _seen_as(self, entry: dict) -> tuple[str, dict]:
        """A write read again, and what the read found ({"etag", "body"}): "landed" (as it was
        meant); "before" (its very version: nothing landed); "not_landed" (the version its own
        write made, without the change); "gone"; "other" (someone else's change since, the same
        lines under a new version included); or "unread" (the read couldn't tell)."""
        try:
            if entry["cal"] == "rule":
                now = family_rules.find(self.ledger, entry["said"])
                return ("landed" if now is not None and now.kind == entry.get("kind") else "before"), {}
            return (self._family_seen if entry["cal"] == "family" else self._gmail_seen)(entry)
        except (ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            return "unread", {}

    def _family_seen(self, entry: dict) -> tuple[str, dict]:
        out, body = self.client.fetch(entry["href"])
        if out.kind not in ("ok", "gone"):
            return "unread", {}
        read = {"etag": out.etag or "", "body": body}
        how = entry["how"]
        if how == "delete":                    # an add: it's there, or it isn't
            if out.kind == "gone":
                return "before", read
            return ("landed" if self._family_shows(entry["check"], body) else "other"), read
        if how == "restore":                   # a removal
            if out.kind == "gone":
                return "landed", read
            return ("before" if out.etag == entry.get("was") else "other"), read
        if out.kind == "gone":
            return "gone", read
        # What was sent, not what a read back kept: a server that kept its old text took the
        # write, version and all, without the change.
        if self._family_shows(entry["check"], body) or caldav._unchanged(body, entry.get("sent", "")):
            return "landed", read
        if out.etag == entry.get("was"):
            return "before", read
        if entry.get("etag") and out.etag == entry["etag"]:
            return "not_landed", read          # its own write's version, read back without the change
        return "other", read

    def _gmail_seen(self, entry: dict) -> tuple[str, dict]:
        address = self.address()
        if not address or self.google is None:
            return "unread", {}
        kind, cur = self.google.look(address, entry["id"])
        if kind == "unknown":
            return "unread", {}
        cancelled = kind == "gone" or (cur or {}).get("status") == "cancelled"
        read = {"etag": (cur or {}).get("etag"), "event": cur or {}}
        how = entry["how"]
        if how == "drop":                      # an add. Google keeps a deleted one, cancelled
            if kind == "gone":
                return "before", read
            return ("other" if cancelled else "landed"), read
        if how == "restore":                   # a removal
            if cancelled:
                return "landed", read
            return ("before" if cur.get("etag") == entry.get("was") else "other"), read
        if cancelled:
            return "gone", read
        if self._as_written(cur, entry.get("wrote") or {}):
            return "landed", read
        if cur.get("etag") == entry.get("was"):
            return "before", read
        if entry.get("etag") and cur.get("etag") == entry["etag"]:
            return "not_landed", read          # its own write's version, read back without the change
        return "other", read

    def _names(self, plan: dict) -> str:
        names = list(dict.fromkeys(part["name"] for part in plan.get("parts", []) if part.get("name")))
        if not names:
            return "that change"
        return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]

    # -- undo ----------------------------------------------------------------------------------
    def _undo_button(self, db, proposal_id: str, label: str = "Undo") -> tuple[list, list]:
        nonce = choices.mint(self.ledger, kind="calendar_change_undo", target=proposal_id,
                             chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
        return [[(label, choices.callback_data(nonce))]], [{"type": "choice", "nonce": nonce}]

    def on_choice(self, kind: str, target: str) -> str:
        if kind != "calendar_change_undo":
            return "Nothing changed."
        pids = [pid for pid in target.split()       # "Undo both" names the later changes too
                if (self.ledger.db.execute("SELECT undo_state FROM calendar_changes WHERE proposal_id=?",
                                           (pid,)).fetchone() or {"undo_state": ""})["undo_state"] == "open"]
        if not pids:
            return "There's nothing to undo there."
        if commands.is_paused(self.ledger):
            # His tap waits with what he asked while stopped, and comes back as its own card.
            rows = [self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
                    for pid in pids]
            with self.ledger.tx() as db:
                commands.note_stopped_undo(self.ledger, "calendar_change", " ".join(pids),
                                           self._undo_words(rows), db)
            return STOPPED_UNDO
        with self.ledger.tx() as db:
            done = 0
            for pid in pids:
                done += db.execute("UPDATE calendar_changes SET undo_state='requested', updated_at=?"
                                   " WHERE proposal_id=? AND undo_state='open'",
                                   (iso(self.ledger.now()), pid)).rowcount
            if not done:
                return "There's nothing to undo there."
        return "Undoing it now."

    @staticmethod
    def _undo_words(rows: list) -> str:
        """His Undo, as its card after Turn back on names it: what each change did, in its words."""
        done = [part["done"] for row in rows for part in _plan(row).get("parts", []) if part.get("done")]
        return ("\u201c" + "; ".join(done) + "\u201d") if done else "that calendar change"

    def _reopen(self, row, words: str) -> None:
        """Undo offered again, as a new request: its tries start over (_undo_attempt)."""
        plan = _plan(row)
        plan.pop("undo", None)                       # its reads are over: a later undo starts afresh
        with self.ledger.tx() as db:
            cur = db.execute("SELECT undo_json FROM calendar_changes WHERE proposal_id=?",
                             (row["proposal_id"],)).fetchone()
            steps = json.loads((cur["undo_json"] if cur else "") or "[]")
            for step in steps:
                step.pop("undo_tries", None)
            db.execute("UPDATE calendar_changes SET undo_state='open', undo_json=?, settle_json=?, updated_at=?"
                       " WHERE proposal_id=?", (json.dumps(steps), json.dumps(plan) if plan else "",
                                                iso(self.ledger.now()), row["proposal_id"]))
            buttons, binds = self._undo_button(db, row["proposal_id"])
            self._say(db, self.chat_id, row["job_id"], words, buttons=buttons, binds=binds)

    def _undo(self, row, paused: bool) -> None:
        """His Undo. Every event is read before anything is written, and what's already back is
        left as it is, so an undo cut short or with a lost answer is simply run again: by itself,
        a minute later, writing at most once more for each event (_undo_attempt)."""
        if paused:
            # His tap waits with what he asked while stopped, and comes back as its own card.
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET undo_state='open', updated_at=? WHERE proposal_id=?",
                           (iso(self.ledger.now()), row["proposal_id"]))
                commands.note_stopped_undo(self.ledger, "calendar_change", row["proposal_id"],
                                           self._undo_words([row]), db)
                self._say(db, self.chat_id, row["job_id"], STOPPED_UNDO)
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
        if problem == "unknown":
            self._undo_not_yet(row)
            return
        if problem is not None:
            again = (" Undo here won't work while it stays that way." if problem == "changed"
                     else " Undo tries again.")
            self._reopen(row, f"<b>Not undone:</b> {_safe(WORDS.get(problem, 'the calendar refused it'))}. "
                              "Nothing changed." + again)
            return
        left = list(steps)
        latest: dict[str, str] = {}          # an event undone a step ago has a new version
        self._undoing = (row["proposal_id"], left)
        try:
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
                    self._undo_rows(db, step.get("rows", []))
        finally:
            self._undoing = None
        if problem is None:
            plan = _plan(row)
            plan.pop("undo", None)
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET undo_state='undone', settle_json=?, updated_at=?"
                           " WHERE proposal_id=?", (json.dumps(plan) if plan else "", iso(self.ledger.now()),
                                                    row["proposal_id"]))
                self._carry_versions(db, row, latest)
                self._say(db, self.chat_id, row["job_id"], "<b>Undone.</b> It's back the way it was.")
            return
        if problem == "unknown":
            self._undo_not_yet(row)
            return
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROBLEM, "Calendar change: an undo didn't finish", db)
        self._reopen(row, f"<b>Not fully undone:</b> {_safe(WORDS.get(problem, 'the calendar refused it'))}. "
                          "Undo tries what's left again.")

    def _undo_not_yet(self, row) -> None:
        """An undo whose reads or answer couldn't say how far it got: run again on the schedule,
        reading first (no Undo button meanwhile: it's still his tap being carried out). Once the
        events are over or a week has passed, he hears it couldn't be confirmed, with Undo, and the
        reads stop."""
        now = self.ledger.now()
        plan = _plan(row)
        state = plan.setdefault("undo", {})
        state.update(since=state.get("since") or iso(now), read_at=iso(now), passes=state.get("passes", 0) + 1)
        why = gave_up(state.get("since"), self._over_at(plan, every=True), now)
        if why:
            with self.ledger.tx() as db:
                self.ledger.set_meta(PROBLEM, "Calendar change: an undo couldn't be confirmed", db)
            self._reopen(row, f"<b>Not confirmed:</b> reads couldn't tell whether {self._names(plan)} went back, "
                              f"and {GAVE_UP_WORDS[why]}, so I've stopped reading it.")
            return
        tell = self._still_due(state, now)
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_state='settling', settle_json=?, updated_at=? WHERE"
                       " proposal_id=?", (json.dumps(plan), iso(now), row["proposal_id"]))
            if tell:
                self._say(db, self.chat_id, row["job_id"], f"I couldn't confirm yet whether {self._names(plan)} "
                                                            "went back; I'm still checking.")

    def _undo_attempt(self, step: dict) -> bool:
        """Just before an undo's write: the first, and at most one more. Kept with the step, so a
        restart doesn't make it a third. A put-back of half a part counts its own the same way."""
        if self._putting_back is not None:
            pid, plan = self._putting_back
            tries = step.get("put_back_tries", 0)
            if tries >= 2:
                return False
            step["put_back_tries"] = tries + 1
            self._save_plan(pid, plan)
            return True
        if self._undoing is None:
            return True
        pid, left = self._undoing
        tries = step.get("undo_tries", 0)
        if tries >= 2:
            return False
        step["undo_tries"] = tries + 1
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET undo_json=? WHERE proposal_id=?", (json.dumps(left), pid))
        return True

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
            return "ok" if out.kind == "gone" else _read_kind(out.kind)
        if out.kind == "gone" and step["how"] == "delete":
            return "ok"
        if out.kind != "ok":
            return _read_kind(out.kind)
        if step["how"] == "put" and caldav._unchanged(body, step["before"]):
            return "ok"                      # already back: an undo cut short after its write
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
        if step["how"] == "change" and self._as_written(cur, step.get("fields") or {}):
            return "ok"                      # already back: an undo cut short after its write
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
            if not self._undo_attempt(step):
                return "not_landed"
            return self._after_undo(self.client.put_new(href, step["before"]), href, latest)
        out, body = self.client.fetch(href)
        if out.kind == "gone" and step["how"] == "delete":
            return "ok"
        if out.kind != "ok":
            return _read_kind(out.kind)
        if step["how"] == "put" and caldav._unchanged(body, step["before"]):
            latest[href] = out.etag or ""
            return "ok"                      # already back: an undo cut short after its write
        expected = latest.get(href, step.get("etag"))
        if out.etag != expected and not caldav._unchanged(body, step.get("after", "")):
            return "changed"
        if not self._undo_attempt(step):
            return "not_landed"
        if step["how"] == "delete":
            kind = self.client.remove_at(href, out.etag or "").kind
            return "ok" if kind == "gone" else kind
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
            elif key in ("summary", "description", "location"):     # none and empty are the same
                if (now.get(key) or "") != (value or ""):
                    return False
            elif key == "recurrence":
                if list(now.get(key) or []) != list(value or []):
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
            if not self._undo_attempt(step):
                return "not_landed"
            out = self.google.change(address, uid, step["fields"], None)
        else:
            if cancelled:
                return "ok" if step["how"] == "drop" else "gone"
            if step["how"] == "change" and self._as_written(cur, step.get("fields") or {}):
                latest[uid] = cur.get("etag") or ""
                return "ok"                  # already back: an undo cut short after its write
            if cur.get("etag") != latest.get(uid, step.get("etag")) \
                    and not self._as_written(cur, step.get("wrote") or {}):
                return "changed"
            if not self._undo_attempt(step):
                return "not_landed"
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
                    "option off, restart Harness, then turn it on to allow them again.")
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
        # Each change a read hasn't settled yet, by what it is: never "check the calendar".
        for r in self.ledger.db.execute("SELECT state, undo_state, settle_json FROM calendar_changes WHERE"
                                        " state='settling' OR undo_state='settling' ORDER BY rowid").fetchall():
            plan = _plan(r)
            if r["state"] == "settling":
                waiting = [render.plain(part["will"]) for part in plan.get("parts", [])
                           if any(x["status"] not in ("landed", "failed") for x in part["steps"])]
                parts.append(f"Not confirmed yet, still checking: {'; '.join(waiting) or 'a calendar change'}.")
            else:
                parts.append(f"Not confirmed yet, still checking: the undo of {render.plain(self._names(plan))}.")
        problem = self.ledger.get_meta(PROBLEM)
        return " ".join(parts + ([problem] if problem else []))

    def _say(self, db, chat_id, job_id, text: str, *, buttons=None, binds=None) -> None:
        self.ledger.enqueue(chat_id=chat_id, kind="reply", job_id=job_id, text=render.fit(text),
                            buttons=buttons, binds=binds, db=db)
        self.ledger.release_held(db=db)


def _length(span: timedelta) -> str:
    """1 hour; 30 minutes; 1 hour 30 minutes."""
    minutes = int(span.total_seconds() // 60)
    hours, rest = divmod(minutes, 60)
    parts = ([f"{hours} hour{'s' * (hours != 1)}"] if hours else []) + \
        ([f"{rest} minute{'s' * (rest != 1)}"] if rest or not hours else [])
    return " ".join(parts)


def _moment(when) -> str:
    """One moment however it was written, to tell the same change named twice."""
    return when.astimezone(timezone.utc).isoformat() if isinstance(when, datetime) else when.isoformat()


def _text(when) -> str:
    """A time as family_copy.py keeps it."""
    return when.isoformat()


def _same_start(a, b) -> bool:
    if isinstance(a, datetime) and isinstance(b, datetime):
        return a.astimezone(timezone.utc) == b.astimezone(timezone.utc)
    return a == b


def _read_kind(kind: str) -> str:
    """A read that failed says nothing about the event: not that the calendar refused."""
    return "unknown" if kind == "failed" else kind


def _plan(row) -> dict:
    """A change's record of its writes (settle_json), or {} where none was kept."""
    try:
        return json.loads(row["settle_json"] or "{}")
    except (ValueError, TypeError, IndexError, KeyError):
        return {}


def _found_json(f: Found) -> dict:
    """An event as planning found it, enough to build its step again after a restart."""
    raw = f.raw if f.calendar == "gmail" else {"href": f.raw.href, "etag": getattr(f.raw, "etag", "") or ""}
    return {"series": f.series, "instance": f.instance, "title": f.title, "first": f.first.isoformat(),
            "last": f.last.isoformat(), "repeats": f.repeats, "start": _text(f.start),
            "end": _text(f.end) if f.end is not None else "", "calendar": f.calendar,
            "copy_of": f.copy_of, "block": f.block, "raw": raw}


def _found_back(d: dict) -> Found:
    raw = d["raw"] if d["calendar"] == "gmail" else caldav.Item(None, d["raw"]["href"], d["raw"]["etag"])
    return Found(d["series"], d["instance"], d["title"], date.fromisoformat(d["first"]),
                 date.fromisoformat(d["last"]), d["repeats"], _when(d["start"]), raw, False, d["calendar"],
                 _when(d["end"]) if d["end"] else None, copy_of=d["copy_of"], block=d["block"])


def _gmail_series(event_id: str) -> str:
    """The series one day of it belongs to, from its id, or "" if it isn't one day of a series."""
    m = re.fullmatch(r"(.+)_\d{8}(T\d{6}Z)?", event_id)
    return m.group(1) if m else ""
