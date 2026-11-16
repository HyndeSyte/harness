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
  * Each write is read back from the calendar before he hears it's done; then the days it touched
    are read again as he'd see them (0.24.0), and only a change that read shows as asked is Done.
    One it doesn't show is said as not confirmed, with what the calendar shows, kept as
    unverified, and never written again on its own.
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
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from . import (caldav, choices, commands, effects, family_copy, family_rules, google_cal, ical, ics_edit,
               net, provenance, render)
from .canonical import canonical_hash
from .family_add import GAVE_UP_WORDS, _looks_pasted, gave_up, read_due
from .ledger import Ledger, iso

log = logging.getLogger("harness.calendar_change")

UNDO_TTL_S = 7 * 24 * 3600
DECLINED_UNDO_TTL_S = 30 * 24 * 3600     # Undo on a change that landed after his Decline (seventh round)
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
# 0.24.0, third round. A change being written counts as being done only while this lease runs;
# past it, a read of the calendar says whether it's done (lease_state).
LEASE_S = 120
# 0.24.0, fourth round: every write to Google or iCloud gets this long, well under the lease, and is
# abandoned after it (_bounded): it's then a write whose answer was lost, settled by reading. A
# write that answers after its change lapsed is fenced out by its token (_drain_late).
WRITE_TIMEOUT_S = 30
# 0.24.0, fifth round: one total deadline for everything a write's thread sends (connect, TLS, the
# request and the whole answer; every request it makes; no retries), enforced in that thread by the
# transport (net.deadline), so an abandoned write ends by itself. Well under the lease, and a
# change's lease is never read as run out until this long after its last write was sent.
WRITE_DEADLINE_S = 45
# Writes abandoned and still running at once, at most: at this many, new writes wait, and the change
# comes back on a card saying writes are paused.
MAX_ABANDONED = 3
PAUSED = "calendar_change_paused:"     # + the request id of a change that came back on a paused card
# A change the read back doesn't show, or one whose lease ran out, is read again in the background
# this long after: about 30 seconds and 2 minutes on, then once more after the long window
# (LATE_READ_S, which the smoke test's record sizes from the listing lag it saw; 10 minutes until
# then), that last read by the event's id where the calendar can. Only after it is it said as not
# found, and its event ids are still read for (WATCH_EVERY, for a week): one that shows up later is
# Done after all, with Undo.
RECHECK_S = (30, 120)
LATE_READ = "calendar_late_read_s"
LATE_READ_S = 600
WATCH_EVERY = timedelta(minutes=30)
WATCH_FOR = timedelta(days=7)
# A read back that disagrees is read once more, this long after, asking past any cache (_read_back).
READ_BACK_PAUSE_S = 3
READ_BACK_DAYS = 60                    # how far on a series's end is read back
SHORT_TITLE = 3                        # a title this short (normalised) never counts as already there

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
         "exists": "that one is already there",
         "not_made": "that event was there before the add, so Undo leaves it",
         "read_back": "the calendar doesn't read back that way",
         "unverified": "the calendar doesn't read back that way"}
# 0.24.0, fourth to sixth rounds: the three paths that apply with no card (his own fresh, clear words;
# a date from his mail he tapped Add to Family on; Family adds after his tap on the bake-in card,
# family_add.tapless) are off after every install. Sixth round: the specialist judges the post-install
# smoke test from its own ledger. Cain starts a smoke run (keeper.sh fastpath smoke-start), the run's
# checklist goes through the normal card path, each change a step of it took (ninth round) recorded under
# the run's id, and
# keeper.sh fastpath on <run id> asks for the result: every item is built here from what the ledger
# recorded (event ids, request and read-back times, the refusals for an older version, the listing lag),
# an item with no evidence is a fail, and anything Cain says passed is ignored. Only a run with every
# item shown is offered to him, on a card with Turn on and Keep cards; only his Turn on tap sets the
# flag, with who and when, and a Turn off button then sits on that card. Off when nothing is recorded.
FAST_PATH = "calendar_fast_path"
FAST_OFFER = "calendar_fast_path_offer"
SMOKE_RUN = "calendar_smoke_run"
SMOKE_MAX = 300
SMOKE_PROVIDERS = ("gmail", "family")
SMOKE_STEPS = ("add", "move", "remove", "undo", "stale")
SMOKE_SERIES = "series"
SMOKE_LATE = "late_landing"
SMOKE_LAG = "listing_lag"
# Ninth round: each calendar's conformance item, the run's own test event edited with a version it made
# stale itself, which the calendar must refuse (CalendarChange.conformance).
CONFORMANCE = "conformance"
# Tenth round: the write kinds the specialist sends with a version, each checked on the run's own test
# events: an edit of a one-off, a removal, and an edit of one day of a series. Each is "enforced" only
# when the calendar gave its documented stale answer (STALE_CODES) and a read after shows the stale write
# wasn't applied; "ignored" when the stale write was applied (or the version didn't move on an edit);
# "incompatible" when the fresh edit itself, sent with the version just read, was turned down; anything
# else (authentication, validation, throttling, unsupported) is "unknown" and keeps the gate closed.
CONFORMANCE_KINDS = ("edit", "remove", "instance")
STALE_CODES = {"gmail": (412, 409), "family": (412,)}
CONFORM_MARK = "Harness safety check"
SMOKE_NONCE_PROP = "harness_smoke_nonce"   # tenth round: the step's nonce; on Family, X-HARNESS-SMOKE-NONCE
SMOKE_ITEMS = tuple(f"{p}.{s}" for p in SMOKE_PROVIDERS for s in SMOKE_STEPS) + (SMOKE_SERIES, SMOKE_LATE,
                                                                                  SMOKE_LAG) \
    + tuple(f"{p}.{CONFORMANCE}" for p in SMOKE_PROVIDERS)
# Seventh round: the listing lag is bounded by what the duplicate and no-card checks can stand (they read
# the listing), at least two samples per calendar, and the measured lag is kept (LISTING_LAG) and fed
# into those checks (_recent_own_add, _fast_path_holds).
LAG_MAX_S = 300
LAG_SAMPLES = 2
LISTING_LAG = "calendar_listing_lag_s"
TURN_OFF_TTL_S = 365 * 24 * 3600
# Seventh round: a smoke run is scoped, single use and bound to this build. It keeps the App version, the
# ledger schema and when it started; it runs out after SMOKE_TTL_S; it stops tagging changes at Turn on,
# Turn off, a new smoke-start or its expiry; it gives one Turn on; and a run that's used, expired, from
# another version or schema, or older than this install is refused. Its adds are tagged (SMOKE_PREFIX on
# the title, a private property), and any still on a calendar are listed with one tap to take them off.
SMOKE_TTL_S = 24 * 3600
SMOKE_PREFIX = "Smoke test: "
SMOKE_PROP = "harness_smoke"           # Google's private extended property; on Family, X-HARNESS-SMOKE
INSTALLED = "calendar_installed"       # {"version", "build", "schema", "at"}: the install this ledger is on
CARD_GATE = "calendar_card_gate"       # {"version", "build", "at", "verified", "seen", "blocked", "override"}
HELD = "calendar_change_held:"          # + proposal: a card held for the check after installing (eighth round)
PASSED_BACK = "calendar_change_passed_back:"   # + proposal: its ready-to-copy summary went to him (eleventh round)
HELD_DAY_TOLD = "calendar_change_held_day:"   # + proposal: told on its day while held (tenth round)
RELEASE_SUMMARY = 3                     # more held changes than this coming back at once: one message first
LEFTOVERS = "calendar_smoke_leftovers:"  # + run id: what its one-tap removal takes off
# Ninth round: the smoke run owns only its own items. Cain opens one step at a time (keeper.sh fastpath
# smoke-step <run id> <step>), and only the next handover naming the run (keeper.sh handover --smoke <run
# id>) is that step's: its request, and every card of its change family, is the run's (tagged, let go,
# judged). Anything else that arrives while a run is live (his own request, a mail date, a Family add) is
# an ordinary request: a closed gate holds it like any other, live run or not, and it's never the run's.
SMOKE_STEP_TTL_S = 30 * 60
SMOKE_OWN = "calendar_smoke_own:"          # + a change family's root job: {"run", "step", "at"}
SMOKE_CREATED = "calendar_smoke_created:"  # + run id: every event the run itself created, by id
# Fourteenth round: the unguarded PUT's own test event on Family, by URL, written before it's created and kept
# until a read shows it gone: {href: {"run", "nonce", "at", "tries"}}. Each start retries the removal
# (sweep_test_events); one still there shows on the status page.
UNGUARDED_LEFT = "calendar_unguarded_test_left"
_STEP_FN = {"gmail_add": ("gmail", "add"), "family_add": ("family", "add"), "gmail_move": ("gmail", "move"),
            "family_move": ("family", "move"), "gmail_remove": ("gmail", "remove"),
            "family_remove_one": ("family", "remove"), "family_remove_days": ("family", "remove")}


def smoke_run(ledger: Ledger) -> dict:
    """The smoke run Cain started, {} when none."""
    try:
        got = json.loads(ledger.get_meta(SMOKE_RUN) or "{}")
    except ValueError:
        return {}
    return got if isinstance(got, dict) else {}


def fast_path(ledger: Ledger) -> dict:
    """What the ledger holds about the no-card paths: {"on": bool, "smoke": what the smoke test
    showed, "at": when it was recorded}. {} when nothing is, which is card-only."""
    try:
        got = json.loads(ledger.get_meta(FAST_PATH) or "{}")
    except ValueError:
        return {}
    return got if isinstance(got, dict) else {}


def late_read_s(ledger: Ledger) -> int:
    """The long window's read, in seconds after the receipt or the lapse (LATE_READ)."""
    try:
        got = int(ledger.get_meta(LATE_READ) or LATE_READ_S)
    except ValueError:
        return LATE_READ_S
    return max(RECHECK_S[-1] + 60, min(got, 3600))


def fast_path_on(ledger: Ledger) -> bool:
    return fast_path(ledger).get("on") is True


def _meta_json(ledger: Ledger, key: str) -> dict:
    try:
        got = json.loads(ledger.get_meta(key) or "{}")
    except ValueError:
        return {}
    return got if isinstance(got, dict) else {}


def test_events_left(ledger: Ledger) -> list[dict]:
    """Fourteenth round: the unguarded PUT's test events not yet shown gone (UNGUARDED_LEFT), oldest first, for
    the status page: [{"href", "run", "at", "tries"}]."""
    got = _meta_json(ledger, UNGUARDED_LEFT)
    out = [{"href": h, "run": str(v.get("run", "")), "at": str(v.get("at", "")), "tries": int(v.get("tries") or 0)}
           for h, v in got.items() if isinstance(v, dict)]
    return sorted(out, key=lambda x: (x["at"], x["href"]))


def card_gate(ledger: Ledger) -> dict:
    """The card path's gate after an install (seventh and eighth rounds): {} when there's none."""
    return _meta_json(ledger, CARD_GATE)


def closed_providers(ledger: Ledger) -> list[str]:
    """The calendars whose cards are held after an install (eighth and ninth rounds): each until the smoke
    run has read back, on that calendar, a fenced edit (sent with If-Match) of an event that was there and an
    edit of one day of a series, and the calendar refused the run's own stale write (the conformance item),
    or until his logged Open cards without the check (or keeper.sh fastpath gate-open) for it. [] when
    there's no gate."""
    gate = card_gate(ledger)
    if not gate:
        return []
    verified, override = gate.get("verified") or {}, gate.get("override") or {}
    return [p for p in SMOKE_PROVIDERS if not verified.get(p) and not override.get(p)]


def conformance_of(ledger: Ledger, provider: str) -> str:
    """What the conformance item found on a calendar after this install (ninth round): "enforced" (it
    refused the run's stale write), "ignored" (it took it: no protection against concurrent edits),
    "unknown" (it couldn't be told), or "" when not run yet."""
    return str(((card_gate(ledger).get("conformance") or {}).get(provider) or {}).get("result") or "")


def etag_strength(ledger: Ledger, provider: str) -> str:
    """Twelfth round: what the check after installing recorded of a calendar's versions: "strong", "weak",
    "none" (it gave none), or "" when not recorded yet."""
    rec = (card_gate(ledger).get("conformance") or {}).get(provider) or {}
    return str(rec.get("etag_strength") or "")


def removals_unprotected(ledger: Ledger, provider: str) -> bool:
    """Tenth round: the conformance item on this calendar, after this install, found its stale removal
    wasn't refused (an edit-only pass, "partial"): removals there stay held, even after an override."""
    rec = (card_gate(ledger).get("conformance") or {}).get(provider) or {}
    return rec.get("result") == "partial"


def card_gate_open(ledger: Ledger) -> bool:
    """Whether every calendar's cards may be offered as actionable (closed_providers is empty)."""
    return not closed_providers(ledger)


def provider_name(provider: str) -> str:
    return "Gmail" if provider == "gmail" else "Family"


def app_build() -> str:
    """This build's identifier (eighth and ninth rounds): the build id the image carries (BUILD_ID beside the
    package, written by the Dockerfile), or else the same hash computed here (buildid.compute) over every
    shipped file: the package, and from a source tree the Dockerfile, config.yaml and rootfs too. So two
    builds of the same version are told apart, a change to the run scripts or the Dockerfile included."""
    global _BUILD
    if _BUILD:
        return _BUILD
    import pathlib
    from . import buildid
    here = pathlib.Path(__file__).resolve().parent
    kept = here.parent / "BUILD_ID"
    try:
        text = kept.read_text().strip()
    except OSError:
        text = ""
    if re.fullmatch(r"[0-9A-Za-z._-]{4,64}", text):
        _BUILD = text
        return _BUILD
    addon = here.parent.parent
    _BUILD = buildid.compute(addon if (addon / "Dockerfile").is_file() else None, here.parent)
    return _BUILD


_BUILD = ""


def listing_lag_s(ledger: Ledger) -> int:
    """The listing lag the passing smoke run measured (seconds, at most LAG_MAX_S); 0 when none."""
    try:
        return max(0, min(int(ledger.get_meta(LISTING_LAG) or 0), LAG_MAX_S))
    except ValueError:
        return 0


def app_version() -> str:
    from . import __version__
    return __version__


def ledger_schema(ledger: Ledger) -> int:
    from . import migrate
    return migrate.schema(ledger)


def retire_turn_on(ledger: Ledger, db) -> int:
    """Every Turn on card still open comes off (seventh round: at install, at Turn off and at a new
    smoke-start): its offer is forgotten, its buttons are used up and taken off, and a tap on it does
    nothing. How many buttons came off."""
    db.execute("DELETE FROM meta WHERE key=?", (FAST_OFFER,))
    now = iso(ledger.now())
    n = 0
    for c in db.execute("SELECT * FROM choices WHERE kind IN ('calendar_change_fast_on','calendar_change_fast_keep')"
                        " AND consumed_at IS NULL").fetchall():
        db.execute("UPDATE choices SET consumed_at=? WHERE nonce=? AND consumed_at IS NULL", (now, c["nonce"]))
        n += 1
        if c["message_id"]:
            if c["kind"] == "calendar_change_fast_on":
                ledger.enqueue(chat_id=c["chat_id"], kind="unbutton", text=str(c["message_id"]), db=db)
        else:
            for o in db.execute("SELECT id FROM outbox WHERE state IN ('queued','held') AND binds_json LIKE ?",
                                (f'%{c["nonce"]}%',)).fetchall():
                db.execute("UPDATE outbox SET buttons_json=NULL, binds_json=NULL WHERE id=?", (o["id"],))
    if n:
        ledger.event("calendar_fast_path_card_retired", {"buttons": n}, db=db)
    return n


def set_fast_path(ledger: Ledger, on: bool, smoke=None, by: str = "", db=None) -> dict:
    """On only from his Turn on tap on the smoke test's card (CalendarChange.on_choice), with the
    record it showed, who tapped and when, kept in the ledger; off at any time (Cain's keeper.sh
    fastpath off, or Keep cards)."""
    record = {"on": bool(on), "smoke": smoke if isinstance(smoke, dict) else
              " ".join(str(smoke or "").split())[:SMOKE_MAX], "at": iso(ledger.now()), "by": str(by or "")}

    def write(d) -> None:
        ledger.set_meta(FAST_PATH, json.dumps(record), d)
        ledger.event("calendar_fast_path", {"on": record["on"], "by": record["by"], "at": record["at"]}, db=d)
    if db is not None:
        write(db)
    else:
        with ledger.tx() as d:
            write(d)
    return record


_MADE_GMAIL = re.compile(r"cm[0-9a-f]{32}")
_MADE_FAMILY = re.compile(r"(?:^|/)hm-[0-9a-f]{32}\.ics$")
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


def exact_title(text: str) -> str:
    """A title as compared for "already there": its words in order, each in one form, so case,
    spacing and punctuation don't count, and nothing else is let go."""
    return " ".join(_WORD.findall(_norm(text or "")))


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


def _copy_line(c: dict, tz: str) -> str:
    """One requested change as a ready-to-copy line (eleventh round): calendar, what, title, when."""
    name = provider_name(c.get("calendar", ""))
    what = {"add": "Add", "add_series": "Add, repeating", "move": "Move", "remove": "Take off",
            "end": "End the series"}.get(c.get("op", ""), "Change")
    when = ""
    try:
        zone = ZoneInfo(tz)
        if c.get("start"):
            s_ = _when(str(c["start"]))
            e_ = _when(str(c["end"])) if c.get("end") else None
            if isinstance(s_, datetime):
                s_ = s_.astimezone(zone) if s_.tzinfo else s_
                when = s_.strftime("%a %d %b %Y, %H:%M")
                if isinstance(e_, datetime):
                    when += " to " + (e_.astimezone(zone) if e_.tzinfo else e_).strftime("%H:%M")
            else:
                when = s_.strftime("%a %d %b %Y")
        elif c.get("dates"):
            when = str(c["dates"]).replace(",", ", ")
    except (ValueError, TypeError):
        when = str(c.get("start") or c.get("dates") or "")
    extra = []
    if c.get("days"):
        extra.append(f"on {c['days']}")
    if c.get("until"):
        extra.append(f"until {str(c['until'])[:10]}")
    if c.get("location"):
        extra.append(f"at {c['location']}")
    return " | ".join(x for x in (name, what, f"\u201c{c.get('title', '')}\u201d", when, " ".join(extra)) if x)


def _weak(etag: str | None) -> bool:
    """A weak entity tag (RFC 9110 8.8.3): If-Match compares strongly, so a weak one never matches there."""
    return bool(etag) and str(etag).startswith("W/")


def _etag_same(a: str | None, b: str | None) -> bool:
    """The weak comparison (RFC 9110 8.8.3.2), used for reads: the opaque tags match, weak or not."""
    if not a or not b:
        return False
    return str(a).removeprefix("W/") == str(b).removeprefix("W/")


# Twelfth round: the stamps each calendar rewrites on any write, pinned per provider. They never count as
# content: not for the re-close rule (changed content under an unchanged version), and not for the
# lost-update compare after a write sent without If-Match. iCloud: DTSTAMP, LAST-MODIFIED, SEQUENCE (it bumps
# it itself) and CREATED; Google: the event's etag, updated, sequence, created and htmlLink.
IGNORED_STAMPS = {"family": ("DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "CREATED"),
                  "gmail": ("etag", "updated", "sequence", "created", "htmlLink")}
_ICS_VOLATILE = re.compile(r"^(?:" + "|".join(IGNORED_STAMPS["family"]) + r")[;:]", re.I)


# Thirteenth round: the unguarded PUT's own test event (_unguarded_put): far in the past, no alarm, a plain title.
UNGUARDED_AT = datetime(2001, 1, 1, 3, 0, tzinfo=timezone.utc)
UNGUARDED_TITLE = SMOKE_PREFIX + "Harness write test (safe to delete)"


def _no_alarm(ics: str) -> str:
    """An iCalendar body without any VALARM."""
    return re.sub(r"BEGIN:VALARM\r?\n.*?END:VALARM\r?\n", "", ics, flags=re.S)


def _ics_fields(body: str) -> dict:
    """An iCalendar body as fields (twelfth round): {(component, property): [values]}, each component keyed
    by its kind and RECURRENCE-ID, without the pinned stamps (IGNORED_STAMPS). For telling which fields a
    write didn't mean to change."""
    text = (body or "").replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "")
    out: dict = {}
    stack: list[list] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        name = re.split(r"[;:]", line, 1)[0].upper()
        if name == "BEGIN":
            stack.append([line.split(":", 1)[-1].upper(), "", []])
            continue
        if name == "END":
            if stack:
                kind, rid, props = stack.pop()
                where = "/".join([x[0] for x in stack] + [kind + (f"[{rid}]" if rid else "")])
                for prop, value in props:
                    out.setdefault((where, prop), []).append(value)
            continue
        if not stack or _ICS_VOLATILE.match(line):
            continue
        if name == "RECURRENCE-ID":
            stack[-1][1] = line.split(":", 1)[-1]
        stack[-1][2].append((name, line))
    return {k: sorted(v) for k, v in out.items()}


def _lost_fields(before: dict, intended: dict, back: dict) -> list[dict]:
    """Twelfth round: after a write sent without If-Match, the fields its read back shows changed that the
    write didn't change (outside the change): [{"field", "was", "now"}]. Field maps from _ics_fields or
    _gmail_fields."""
    ours = {k for k in set(before) | set(intended) if before.get(k) != intended.get(k)}
    lost = []
    for k in sorted(set(before) | set(back), key=str):
        if k in ours or before.get(k) == back.get(k):
            continue
        lost.append({"field": k, "was": before.get(k), "now": back.get(k)})
    return lost


_GMAIL_READ_ONLY = ("id", "kind", "iCalUID", "creator", "organizer")


def _field_key(field) -> str:
    """A field of _ics_fields or _gmail_fields as a baseline key: the component path without its RECURRENCE-ID."""
    if isinstance(field, (tuple, list)):
        return re.sub(r"\[[^\]]*\]", "", str(field[0])) + "/" + str(field[1])
    return str(field)


def _canon(value) -> str:
    """A value with what a calendar normalises taken out: an iCalendar line's name and parameters, escapes, case
    and spacing."""
    if isinstance(value, list):
        value = "\n".join(re.sub(r"^[A-Z-]+(?:;[^:]*)?:", "", str(v)) for v in value)
    return " ".join(str(value).replace("\\", "").lower().split())


# Fourteenth round: which fields a baseline may loosen, and which are compared by when they resolve to.
_TEXT_FIELDS = {"SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT", "CATEGORIES", "CONTACT", "RESOURCES",
                "summary", "description", "location"}
_TEMPORAL_FIELDS = {"DTSTART", "DTEND", "DUE", "RECURRENCE-ID", "EXDATE", "RDATE", "RRULE", "EXRULE",
                    "start", "end", "originalStartTime", "recurrence"}


def _prop(field) -> str:
    """The property a field of _ics_fields or _gmail_fields is: the iCalendar name, or Google's key."""
    return str(field[1]) if isinstance(field, (tuple, list)) else str(field)


def _bare(value) -> list[str] | str:
    """A value without its iCalendar name and parameters (an exact compare, nothing loosened)."""
    if isinstance(value, list):
        return sorted(re.sub(r"^[A-Z-]+(?:;[^:]*)?:", "", str(v)) for v in value)
    return value


# Fifteenth round: zone names calendars write that aren't IANA names, mapped to the IANA name before a zone is
# compared or a baseline's zone rewrite recorded: Windows ids (Outlook, Exchange), their display names, legacy
# links, and the prefixed forms some clients and iCloud write (/mozilla.org/.../America/New_York).
ZONE_ALIASES = {
    "eastern standard time": "America/New_York", "eastern time (us & canada)": "America/New_York",
    "us eastern standard time": "America/Indiana/Indianapolis",
    "central standard time": "America/Chicago", "central time (us & canada)": "America/Chicago",
    "mountain standard time": "America/Denver", "mountain time (us & canada)": "America/Denver",
    "us mountain standard time": "America/Phoenix", "arizona": "America/Phoenix",
    "pacific standard time": "America/Los_Angeles", "pacific time (us & canada)": "America/Los_Angeles",
    "alaskan standard time": "America/Anchorage", "alaska": "America/Anchorage",
    "hawaiian standard time": "Pacific/Honolulu", "hawaii": "Pacific/Honolulu",
    "atlantic standard time": "America/Halifax", "atlantic time (canada)": "America/Halifax",
    "gmt standard time": "Europe/London", "greenwich standard time": "Atlantic/Reykjavik",
    "w. europe standard time": "Europe/Berlin", "romance standard time": "Europe/Paris",
    "central europe standard time": "Europe/Budapest", "central european standard time": "Europe/Warsaw",
    "e. europe standard time": "Europe/Chisinau", "gtb standard time": "Europe/Bucharest",
    "fle standard time": "Europe/Kiev", "tokyo standard time": "Asia/Tokyo",
    "china standard time": "Asia/Shanghai", "india standard time": "Asia/Kolkata",
    "aus eastern standard time": "Australia/Sydney", "utc": "UTC", "coordinated universal time": "UTC",
    "us/eastern": "America/New_York", "us/central": "America/Chicago", "us/mountain": "America/Denver",
    "us/pacific": "America/Los_Angeles", "us/alaska": "America/Anchorage", "us/hawaii": "Pacific/Honolulu",
    "us/arizona": "America/Phoenix", "us/east-indiana": "America/Indiana/Indianapolis",
    "est5edt": "America/New_York", "cst6cdt": "America/Chicago", "mst7mdt": "America/Denver",
    "pst8pdt": "America/Los_Angeles", "gb": "Europe/London", "asia/calcutta": "Asia/Kolkata",
    "etc/utc": "UTC", "etc/gmt": "UTC", "gmt": "UTC", "z": "UTC", "zulu": "UTC", "uct": "UTC", "universal": "UTC",
    "etc/universal": "UTC", "etc/zulu": "UTC", "etc/uct": "UTC",
}


def iana_zone(zone: str) -> str:
    """Fifteenth round: a zone as its IANA name (ZONE_ALIASES), or as written when it isn't a known alias."""
    text = str(zone or "").strip().strip('"')
    if not text:
        return ""
    m_ = re.match(r"^\(UTC[^)]*\)\s*(.+)$", text)            # Outlook's "(UTC-05:00) Eastern Time (US & Canada)"
    if m_:
        text = m_.group(1).strip()
    if text.startswith("/"):                                   # /mozilla.org/20050126_1/America/New_York and kin
        parts = [p for p in text.split("/") if p]
        for i in range(len(parts)):
            cand = "/".join(parts[i:])
            if cand.lower() in ZONE_ALIASES or re.fullmatch(r"[A-Z][A-Za-z_]+(?:/[A-Za-z0-9_+-]+)+", cand):
                text = cand
                break
    return ZONE_ALIASES.get(text.lower(), text)


def zone_forms(*bodies: str) -> dict:
    """Fifteenth round, for the smoke run's record: the zone names a calendar wrote (TZID parameters and VTIMEZONE
    ids as written, or Google's timeZone values) and the IANA names they map to."""
    raw: set = set()
    for body in bodies:
        if isinstance(body, dict):
            for k in ("start", "end", "originalStartTime"):
                v = body.get(k)
                if isinstance(v, dict) and v.get("timeZone"):
                    raw.add(str(v["timeZone"]))
            continue
        for m_ in re.finditer(r"(?:;TZID=|^TZID:)\"?([^\";:\r\n]+)", str(body or ""), re.M):
            raw.add(m_.group(1).strip())
    return {"written": sorted(raw), "iana": sorted({iana_zone(z) for z in raw})}


def _ics_when(text: str, params: dict) -> tuple | None:
    """One iCalendar date or date-time as (all-day, instant, zone): the UTC instant (or the date), so a time zone
    or all-day change shows; None when it can't be resolved (an unknown zone, a period)."""
    text = text.strip()
    if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", text):
        return (True, text, "") if re.fullmatch(r"\d{8}", text) else None
    m_ = re.fullmatch(r"(\d{8}T\d{6})(Z?)", text)
    if not m_:
        return None
    naive = datetime.strptime(m_.group(1), "%Y%m%dT%H%M%S")
    if m_.group(2):
        return (False, naive.replace(tzinfo=timezone.utc).isoformat(), "UTC")
    zone = iana_zone(params.get("TZID", ""))
    if not zone:
        return (False, "floating " + naive.isoformat(), "")
    try:
        return (False, naive.replace(tzinfo=ZoneInfo(zone)).astimezone(timezone.utc).isoformat(), zone)
    except (KeyError, ValueError, OSError):
        return None


def _rule(text: str) -> tuple | None:
    """An RRULE as its parts in order, with UNTIL resolved (_ics_when)."""
    parts = {}
    for p in text.strip().split(";"):
        if "=" not in p:
            return None
        k, v = p.split("=", 1)
        parts[k.strip().upper()] = v.strip().upper()
    if "UNTIL" in parts:
        until = _ics_when(parts["UNTIL"], {})
        if until is None:
            return None
        parts["UNTIL"] = repr(until[:2])
    return tuple(sorted(parts.items()))


_KNOWN_TIME_PARAMS = {"TZID", "VALUE"}


def _resolved(field, value, strict: bool = False) -> tuple | None:
    """Fourteenth round: a temporal field (_TEMPORAL_FIELDS) as what it means: (sorted resolved values, sorted
    zones). None when any part can't be resolved, which counts as a real change. Fifteenth round: zones by their
    IANA names (iana_zone); strict, a parameter other than TZID and VALUE can't be resolved either."""
    if value is None:
        return None
    whens: list = []
    zones: set = set()
    if isinstance(value, list):                                  # iCalendar lines
        for line in value:
            head, _, body = str(line).partition(":")
            name, *raw = head.split(";")
            params = {}
            for p in raw:
                k, _, v = p.partition("=")
                params[k.strip().upper()] = v.strip().strip('"')
            if strict and set(params) - _KNOWN_TIME_PARAMS:
                return None
            if name.upper() in ("RRULE", "EXRULE"):
                r = _rule(body)
                if r is None:
                    return None
                whens.append(("rule", r))
                continue
            for one in body.split(","):
                w = _ics_when(one, params)
                if w is None:
                    return None
                whens.append(w[:2])
                zones.add(w[2])
        return tuple(sorted(map(repr, whens))), tuple(sorted(zones))
    try:                                                         # Google: a JSON value
        v = json.loads(value) if isinstance(value, str) else value
    except ValueError:
        return None
    if _prop(field) == "recurrence":
        if not isinstance(v, list):
            return None
        return _resolved(("", "RRULE"), [str(x) for x in v])
    if not isinstance(v, dict):
        return None
    if v.get("date"):
        return (repr((True, str(v["date"]).replace("-", ""))),), ("",)
    try:
        at = datetime.fromisoformat(str(v.get("dateTime", "")).replace("Z", "+00:00"))
    except ValueError:
        return None
    zone = iana_zone(str(v.get("timeZone") or ""))
    if at.tzinfo is None:
        if not zone:
            return None
        try:
            at = at.replace(tzinfo=ZoneInfo(zone))
        except (KeyError, ValueError, OSError):
            return None
    return (repr((False, at.astimezone(timezone.utc).isoformat())),), (zone or "offset",)


def _baseline_of(diff: list[dict]) -> dict:
    """Thirteenth round: a no-op round trip's differences as a calendar's baseline: {field key: {"kind": "added",
    "now": value} | {"kind": "removed", "was": value} | {"kind": "changed", "now": value}}. Fourteenth round: a
    removal keeps the value removed, a change keeps the value it became, and a change of a temporal field keeps
    the zones it went from and to."""
    out = {}
    for x in diff:
        key = _field_key(x["field"])
        if x["was"] is None:
            out[key] = {"kind": "added", "now": x["now"]}
        elif x["now"] is None:
            out[key] = {"kind": "removed", "was": x["was"]}
        else:
            out[key] = {"kind": "changed", "now": x["now"]}
            if _prop(x["field"]) in _TEMPORAL_FIELDS:
                was, now = _resolved(x["field"], x["was"]), _resolved(x["field"], x["now"])
                if was and now:
                    out[key]["zones"] = [list(was[1]), list(now[1])]
    return out


def _matches_baseline(x: dict, baseline: dict | None) -> bool:
    """Whether a difference after a write is only the calendar's own normalisation (thirteenth round): the same
    field changed the same way in the baseline. Fourteenth round, narrower: added with the same value; removed
    only when the value removed is the one the baseline showed removed (an empty or default one, never any
    value); changed, for a text field the baseline showed changed, to a value that's the same once spacing,
    case, escapes and parameters are set aside (_canon); for a temporal field (DTSTART, DTEND, RECURRENCE-ID,
    EXDATE, RRULE, VALUE=DATE or DATE-TIME) to one that resolves to the same instant or date and all-day status,
    in the same zone or with the very zone rewrite the baseline showed; for any other field, to the same value
    the baseline's change gave. Anything else, or anything that can't be resolved, is someone's edit."""
    b = (baseline or {}).get(_field_key(x["field"]))
    if not b:
        return False
    kind = "added" if x["was"] is None else "removed" if x["now"] is None else "changed"
    if b.get("kind") != kind:
        return False
    prop = _prop(x["field"])
    if kind == "added":
        return x["now"] == b.get("now")
    if kind == "removed":
        if "was" not in b:
            return False
        if prop in _TEMPORAL_FIELDS:
            # Fifteenth round: a removed time by what it means (instant or date, all-day, zone), like a kept one,
            # never with its parameters set aside; one that can't be resolved is reported.
            was, base = _resolved(x["field"], x["was"], strict=True), _resolved(x["field"], b.get("was"), strict=True)
            return was is not None and base is not None and was == base
        return _bare(x["was"]) == _bare(b.get("was"))
    if prop in _TEMPORAL_FIELDS:
        was, now = _resolved(x["field"], x["was"]), _resolved(x["field"], x["now"])
        if was is None or now is None or was[0] != now[0]:
            return False
        return was[1] == now[1] or [list(was[1]), list(now[1])] == b.get("zones")
    if prop in _TEXT_FIELDS:
        return _canon(x["was"]) == _canon(x["now"])
    return "now" in b and _bare(x["now"]) == _bare(b.get("now"))


def _gmail_fields(event: dict) -> dict:
    """A Google event as fields, without the pinned stamps (IGNORED_STAMPS)."""
    return {k: json.dumps(v, sort_keys=True) for k, v in (event or {}).items() if k not in IGNORED_STAMPS["gmail"]}


def _ics_content(body: str) -> str:
    """An iCalendar body as content: unfolded, without the stamps a server rewrites on any write."""
    text = (body or "").replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "")
    return "\n".join(line.strip() for line in text.split("\n") if line.strip() and not _ICS_VOLATILE.match(line))


def _when(text: str) -> datetime | date:
    return date.fromisoformat(text) if effects.DATE_RE.fullmatch(text) else datetime.fromisoformat(text)


def add_anyway_key(proposal_id: str, index: int) -> str:
    """The key an Add anyway's add takes its fixed id from (seventeenth round): the receipt's proposal and the
    add's place, so the same tap taken twice writes to one id."""
    return f"anyway:{proposal_id}:{index}"


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
        self.unsent = False              # eighth round: stale before any write went out (_card_etag)


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
    # 0.24.0: a removal's events, as a read found them when it was offered (calendar, id, title,
    # time), so the card names them and the run takes off only those (Nov 15).
    bound: list[dict] = field(default_factory=list)
    already: str = ""                  # an add whose slot already holds the same event: nothing to write
    # 0.24.0, third round: what the calendar must show once it's done, read back before Done
    # (_read_back); and an add whose slot holds one only like it, which waits for his decision.
    expect: list[dict] = field(default_factory=list)
    loose: str = ""
    change: dict = field(default_factory=dict)       # an add's change as asked, for Add anyway
    # 0.24.0, fifth round: an add already there, when the calendar was made: the provider's own
    # created field (Google's "created", iCloud's CREATED), "" when it has none (migrate.py).
    created: str = ""
    # 0.24.0, sixth round: an add already there, the id of the event found (Google's id, or the
    # iCloud UID), so a late write of an earlier approval found there is said as ours (_adopt_late).
    found_id: str = ""


@dataclass
class Preview:
    """What a change will do, found on a fresh read, and what to check before it does."""
    lines: list[str]
    checks: list[str] = field(default_factory=list)
    bound: list[dict] = field(default_factory=list)      # each removal's events, as found (Part.bound)
    loose: list[str] = field(default_factory=list)       # an event like an add's, already in its slot


@dataclass(frozen=True)
class FamilyRead:
    """One read of an iCloud resource: its address, body and version, together (seventh round)."""
    href: str
    body: str
    etag: str


class CalendarChange:
    def __init__(self, ledger: Ledger, client, google, *, enabled: Callable[[], bool],
                 address: Callable[[], str | None], tz: str, sleep: Callable[[float], None] = time.sleep):
        self.ledger = ledger
        self.sleep = sleep                 # the pause before a read back is read once more
        self.client = client               # caldav.FamilyCalDav
        self.google = google               # google_cal.GoogleCalendar, or None
        self.enabled = enabled             # the add-on's option: True, False, or None if unread
        self.address = address             # his Gmail address, as its feed names itself
        self.tz = tz
        self.chat_id: int | None = None
        self.touched = False               # something landed this tick: read Family again now
        # The step being run: (proposal, plan, its record, the version a retry must find, or None).
        self._recording: tuple | None = None
        self._rcw_seen: set = set()        # twelfth round: calendars written without If-Match since reset
        self._undoing: tuple | None = None     # the undo being run: (proposal, its steps left)
        self._putting_back: tuple | None = None    # a half-done part being put back: (proposal, plan)
        self._forcing = False                  # planning an Add anyway: no already-there check
        self.write_timeout_s = WRITE_TIMEOUT_S
        self.write_deadline_s = WRITE_DEADLINE_S
        # Writes abandoned at their timeout that answered later: (proposal, fence, calendar, outcome),
        # put here by the write's own thread and handled on the controller's (_drain_late).
        self._late: "queue.SimpleQueue[tuple]" = queue.SimpleQueue()
        self.abandoned: list[threading.Thread] = []
        self._late_probe = False                 # the smoke run's first add is being written (_bounded)
        self._smoke_now = ""                     # the live smoke run, while its change is planned (_add_part)
        # The fast path's check at the moment of the write (controller._still_his): "" when his
        # message is still his newest and fresh, or why not. None: nothing to check (no Discord).
        self.fast_check: Callable[[Any], Any] | None = None
        # Right after a no-tap change is written: his messages since the newest one its claim
        # recorded (controller._newer_since), each read as a correction of it.
        self.after_fast: Callable[[Any, str], list[str]] | None = None
        self._fast_seen: dict[str, str] = {}
        # A fast-path change that can't go without a tap after all becomes his card (runner).
        self.to_card: Callable[[Any, str], None] | None = None
        # His Propose again, and his pick of which card a note corrects, become cards (runner).
        self.reoffer: Callable[[str, str], str] | None = None
        # A change the calendar refused for its version, offered again on a fresh card (sixth round):
        # runner.recard(proposal, changes, why).
        self.recard: Callable[[Any, list, str, bool], str] | None = None
        # His Try again or Start again from now: the change on a new card, a new change family (eighth
        # round): runner.start_again(proposal, changes, why).
        self.start_again: Callable[[Any, list, str], str] | None = None
        # Tenth round: a smoke step's change, from its own script, on a card (runner.script_card).
        self.script_card: Callable[..., str] | None = None

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
        return self._preview_of(parts, checks)

    def preview_quiet(self, job, params: dict) -> Preview | None:
        """preview for one change of several already found clear together (runner._split): what it
        will do and what to check, saying nothing and moving no job. None: it can't be read alone."""
        try:
            parts, _ = self._plan_all(params, "preview")
        except (Refuse, ValueError, KeyError, TypeError, ical.Unreadable, ics_edit.Cant):
            return None
        return self._preview_of(parts, self._checks(job, parts))

    def _preview_of(self, parts: list[Part], checks: list[str]) -> Preview:
        """Each part's line, a removal's naming the very events it takes off (calendar, title,
        time, id), so what he approves is those events and nothing a later read finds instead."""
        lines = []
        for p in parts:
            if p.already:
                lines.append(p.already)
            elif p.bound and any(b.get("op", "remove") != "move" for b in p.bound):
                # What a removal or a series's end takes off, by name and id; a move's line already
                # says which event, and it's bound by id all the same (_drifted).
                lines.append(p.will + ": " + "; ".join(self._bound_words(b) for b in p.bound))
            else:
                lines.append(p.will)
            if p.loose:
                lines.append(p.loose)
        return Preview(lines, checks, [b for p in parts for b in p.bound], [p.loose for p in parts if p.loose])

    def _bound_words(self, b: dict) -> str:
        """the Gmail event "Busy (school drop-off)", 8:00 AM Wed Nov 11, id ending 4f2a9c"""
        when = _when(b["start"]) if b.get("start") else None
        if isinstance(when, datetime):
            local = when.astimezone(ZoneInfo(self.tz))
            at = f"{render.clock_words(local, suffix=True)} {local:%a %b} {local.day}"
        elif isinstance(when, date):
            at = f"{when:%a %b} {when.day}, all day"
        else:
            at = ""
        cal = "Gmail" if b["calendar"] == "gmail" else "Family"
        tail = re.sub(r"[^0-9A-Za-z]", "", b.get("id") or "")[-6:]
        scope = {"occurrence": ", this occurrence only (the rest of the series stays)",
                 "series": ", the whole series from then on"}.get(b.get("scope", ""), "")
        return (f"the {cal} event \u201c{_safe(b['title'])}\u201d" + (f", {at}" if at else "")
                + scope + (f", id ending {tail}" if tail else ""))

    def _bound_of(self, f: "Found", op: str = "remove", scope: str = "") -> list[dict]:
        """An event and its copies, as a read found them now: which calendar, its id, the day of a
        series it is (its recurrence id) and whether the change is to that day or to the whole
        series (0.24.0, third round), so the run touches exactly that and Undo puts back exactly
        that."""
        out = []
        for x in [f, *f.copies]:
            ident = x.instance if x.calendar == "gmail" else (
                caldav.href_path(getattr(x.raw, "href", "") or "").rsplit("/", 1)[-1] or x.series)
            # 0.24.0, fifth round: the event's version as the card's read found it (Google's etag, or
            # the iCloud resource's), sent with the write as If-Match, so a stale move or removal is
            # refused by the calendar itself (_card_etag). Kept byte for byte as the calendar gave it,
            # quotes and a weak marker included (sixth round).
            # Ninth round: a Google event is bound from a read of it by its id, the very read the pre-write
            # compare makes (_gmail_fresh), so the two are the same endpoint and shape; the listing only
            # when that read can't answer.
            raw = self._gmail_by_id(x) if x.calendar == "gmail" else None
            etag = ((raw or x.raw).get("etag") if isinstance(raw or x.raw, dict)
                    else getattr(x.raw, "etag", "")) or ""
            b = {"calendar": x.calendar, "series": x.series, "instance": x.instance, "id": ident,
                 "title": x.title, "start": _text(x.start) if x.start is not None else "",
                 "op": op, "recurrence": x.instance if x.repeats else "",
                 "scope": scope or ("occurrence" if x.repeats else "event"), "etag": etag}
            # 0.24.0, sixth round: everything the card showed of the event it targets (title, start, end,
            # all day or not, its series's rule, location and notes), so a version that moved on is only
            # ever taken for the card's when all of it still reads the same (_card_etag).
            shown = self._print_of(x, raw)
            if shown is not None:
                b["print"] = shown
            out.append(b)
        return out

    def _gmail_by_id(self, x: "Found") -> dict | None:
        """A Google event as a read by its id gives it (ninth round), or None when that read can't answer."""
        ident = (x.raw or {}).get("id") if isinstance(x.raw, dict) else ""
        if not ident:
            return None
        try:
            kind, ev = self.google.look(self._gmail_address(), ident)
        except (Refuse, ValueError, KeyError, TypeError, AttributeError):
            return None
        return ev if kind == "ok" and isinstance(ev, dict) and ev.get("status") != "cancelled" else None

    def _print_of(self, x: "Found", raw: dict | None = None) -> dict | None:
        try:
            if x.calendar == "gmail":
                raw = raw or x.raw
                if not isinstance(raw, dict):
                    return None
                return self._gmail_print(raw)
            data = getattr(x.raw, "data", "") or ""
            return self._family_print(data, x.instance, x.first) if data else None
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            return None

    def _gmail_print(self, ev: dict, master: dict | None = None) -> dict | None:
        """A Google event as the card showed it, for the version compare (_card_etag). A day of a
        series carries its series's rule, read from the series itself. None when it can't be read."""
        start, end = self._gmail_when(ev.get("start")), self._gmail_when(ev.get("end"))
        if start is None or end is None:
            return None
        rule = ev.get("recurrence")
        if ev.get("recurringEventId"):
            if master is None:
                kind, master = self.google.look(self._gmail_address(), ev["recurringEventId"])
                if kind != "ok" or not master:
                    return None
            rule = master.get("recurrence")
        people = [((a or {}).get("email", ""), (a or {}).get("responseStatus", ""))
                  for a in ev.get("attendees") or []]
        return _print(ev.get("summary", ""), start, end, list(rule or []), ev.get("location", ""),
                      ev.get("description", ""), people, (ev.get("organizer") or {}).get("email", ""),
                      ev.get("transparency", ""))

    def _family_print(self, body: str, instance: str, day: date) -> dict | None:
        """One occurrence of an iCloud resource as the card showed it (_card_etag): its own VEVENT
        (an override for that day, or the series), and the series's RRULE. None when it isn't found
        near that day."""
        occs = self._occurrences(body, *self._bounds([day - timedelta(days=1), day + timedelta(days=1)]))
        o = next((o for o in occs if o.instance == instance), None)
        if o is None:
            return None
        _, events = ical.parse_calendar(body)
        zone = ZoneInfo(self.tz)
        master = next((e for e in events if e.first("RECURRENCE-ID") is None), None)
        own = master
        for e in events:
            rid = e.first("RECURRENCE-ID")
            if rid is not None and ical._key(ical.parse_when(rid, zone)) == instance:
                own = e
        rule = [p.value for p in master.all("RRULE")] if master is not None else []
        notes = own.first("DESCRIPTION") if own is not None else None
        place = own.first("LOCATION") if own is not None else None
        people = [(a.value.strip().lower().removeprefix("mailto:"), a.params.get("PARTSTAT", "needs-action"))
                  for a in (own.all("ATTENDEE") if own is not None else [])]
        org = own.first("ORGANIZER") if own is not None else None
        transp = own.first("TRANSP") if own is not None else None
        return _print(o.summary, o.start, o.end, rule, ical.unescape(place.value) if place else "",
                      ical.unescape(notes.value) if notes else "",
                      people, org.value if org else "", transp.value if transp else "")

    def _shared(self, calendar: str, now: Any) -> bool:
        """An event whose version can move on with no change to it (sixth round): a day of a Google
        series, or an iCloud resource holding a series or more than one event. Only then may a
        version that moved on since the card stand for the card's."""
        try:
            if calendar == "gmail":
                return bool((now or {}).get("recurringEventId"))
            _, events = ical.parse_calendar(now or "")
            return len(events) > 1 or ics_edit.is_series(now or "")
        except (ValueError, TypeError, AttributeError, ical.Unreadable):
            return False

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
        out += ["an event like it is already at that time, so nothing is added unless you tap Add anyway."
                for part in parts if part.loose]
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

    def note_lines(self, proposal_id: str, lines: list[str], db, seen: "Preview | None" = None) -> None:
        """What a card offered, so the tap's reply says what will happen; and the events a removal
        takes off and the adds already there, as the read for it found them, so the run does
        exactly that (_drifted)."""
        if lines:
            self.ledger.set_meta(f"calendar_change_lines:{proposal_id}", json.dumps(lines), db)
        if seen is not None:
            self.ledger.set_meta(f"calendar_change_bound:{proposal_id}", json.dumps(
                {"bound": seen.bound, "already": sum(1 for x in seen.lines if x.startswith("Already there")),
                 "loose": list(seen.loose)}), db)

    def decline_words(self, proposal_id: str, db) -> str | None:
        """His Leave it on an add whose slot already holds one like it: nothing is added, and the
        record keeps that he looked and left it, so a rerun says it's settled (runner._not_yet_done).
        None for any other card."""
        kept = self.bound_of(proposal_id) or {}
        if not kept.get("loose"):
            return None
        self.ledger.set_meta(f"calendar_change_left:{proposal_id}", iso(self.ledger.now()), db)
        return "Left as it is. Nothing was added."

    def bound_of(self, proposal_id: str) -> dict | None:
        raw = self.ledger.get_meta(f"calendar_change_bound:{proposal_id}")
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def _drifted(self, proposal_id: str, parts: list[Part]) -> str:
        """What the run would do that isn't what was offered: another event to take off than the
        one the card named (by calendar and id), or an add the card said was already there and
        isn't now. "" when it's the same, or nothing was kept (a proposal from before 0.24.0)."""
        kept = self.bound_of(proposal_id)
        if kept is None:
            return ""
        key = lambda b: (b["calendar"], b["series"], b["instance"])   # noqa: E731
        was = {key(b) for b in kept.get("bound", [])}
        now = {key(b) for part in parts for b in part.bound}
        if was != now:
            return "the event to take off isn't the one that card named any more."
        # The card said it was already there and now it isn't: a write he didn't see offered. The
        # other way round (it's there now) writes nothing, and the receipt names what's there.
        if kept.get("already", 0) > sum(1 for part in parts if part.already):
            return "what's on the calendar in that slot changed since the card."
        return ""

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
                if self._is_duplicate(c) and not self._there_now(c):
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

    def _there_now(self, c: dict) -> bool:
        """The very event an add asks for is on the calendar now, so nothing will be written: no
        duplicate to warn about (_already_there)."""
        if c["op"] != "add":
            return False
        try:
            start, end, rule = self._new_times(c)
        except (Refuse, ValueError, KeyError, TypeError):
            return False
        return self._already_there(c, start, end, rule)[0] is not None

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

    # -- the smoke run, judged from the ledger (sixth and seventh rounds) ----------------------
    def smoke_start(self) -> dict:
        """Cain's keeper.sh fastpath smoke-start: a new smoke run under an id issued here, bound to this
        build (the App version and the ledger schema) and to the next SMOKE_TTL_S. Only the requests its
        steps took (ninth and tenth rounds: smoke_step, start_step) are recorded under it, their adds tagged as tests,
        and its first add is let go at once, so its answer comes late and is read back like any lost answer (the late landing item). A
        run started before stops here: its Turn on card, if any, comes off."""
        import secrets
        now = self.ledger.now()
        run = {"id": secrets.token_hex(6), "at": iso(now), "late_probe": "pending", "version": app_version(),
               "build": app_build(), "schema": ledger_schema(self.ledger), "expires": iso(now + timedelta(seconds=SMOKE_TTL_S))}
        with self.ledger.tx() as db:
            old = smoke_run(self.ledger)
            if old.get("id") and not old.get("closed"):
                self._close_run(db, old, "replaced")
            self.retire_turn_on(db)
            self.ledger.set_meta(SMOKE_RUN, json.dumps(run), db)
            self.ledger.event("calendar_smoke_start", {"run": run["id"], "version": run["version"]}, db=db)
        return run

    def run_problem(self, run: dict, run_id: str = "") -> str:
        """Why a smoke run can't be used (seventh round), or "": the id it names isn't the current run,
        it's used or closed, it ran out, or it was started under another version, another ledger schema
        or before this install."""
        if not run.get("id") or (run_id and run.get("id") != run_id):
            return "no smoke run with that id: start one with keeper.sh fastpath smoke-start"
        if run.get("used"):
            return "that smoke run was already used for a Turn on: start a new one with keeper.sh fastpath smoke-start"
        if run.get("closed"):
            why = {"turned_off": "Turn off ended it", "replaced": "a newer smoke run replaced it",
                   "expired": f"it ran out after {SMOKE_TTL_S // 3600} hours",
                   "install": "an update was installed since"}.get(run.get("closed_why", ""), "it's closed")
            return f"that smoke run is over ({why}): start a new one with keeper.sh fastpath smoke-start"
        try:
            expires = datetime.fromisoformat(run.get("expires") or "")
            started = datetime.fromisoformat(run["at"])
        except (ValueError, TypeError, KeyError):
            return "that smoke run's record can't be read: start a new one with keeper.sh fastpath smoke-start"
        if self.ledger.now() >= expires or self.ledger.now() - started >= timedelta(seconds=SMOKE_TTL_S):
            return (f"that smoke run ran out after {SMOKE_TTL_S // 3600} hours: start a new one with keeper.sh "
                    "fastpath smoke-start")
        if run.get("version") != app_version():
            return (f"that smoke run was started under version {run.get('version') or 'unknown'}, not "
                    f"{app_version()}: start a new one with keeper.sh fastpath smoke-start")
        if run.get("build", app_build()) != app_build():
            return "that smoke run was started under another build: start a new one with keeper.sh fastpath smoke-start"
        if run.get("schema") != ledger_schema(self.ledger):
            return "that smoke run was started under another ledger schema: start a new one with keeper.sh fastpath smoke-start"
        installed = _meta_json(self.ledger, INSTALLED)
        try:
            if installed.get("at") and started < datetime.fromisoformat(installed["at"]):
                return "that smoke run is older than this install: start a new one with keeper.sh fastpath smoke-start"
        except ValueError:
            pass
        return ""

    def live_run(self) -> dict:
        """The smoke run while it's live (run_problem says nothing), else {}."""
        run = smoke_run(self.ledger)
        return run if run.get("id") and not self.run_problem(run) else {}

    def _close_run(self, db, run: dict, why: str, used: bool = False) -> None:
        """A smoke run ends: nothing more is tagged under it, and its id gives no Turn on after."""
        run = dict(run)
        run.update(closed=iso(self.ledger.now()), closed_why=why)
        if used:
            run["used"] = iso(self.ledger.now())
        if run.get("late_probe") == "pending":
            run["late_probe"] = ""
        self.ledger.set_meta(SMOKE_RUN, json.dumps(run), db)
        self.ledger.event("calendar_smoke_closed", {"run": run.get("id", ""), "why": why}, db=db)

    def retire_turn_on(self, db) -> int:
        """Every Turn on card still open comes off (retire_turn_on)."""
        return retire_turn_on(self.ledger, db)

    # -- the run's own steps (ninth round) ------------------------------------------------------
    def smoke_step(self, run_id: str, step: str, script: dict | None = None) -> tuple[str, str, dict]:
        """Cain's keeper.sh fastpath smoke-step <run id> <step> <calendar> <kind> <day> <title> [HH:MM-HH:MM]
        (ninth and tenth rounds): (status, said, extra). An ordinary step carries its script (calendar,
        kind, test title, day, times: check_script) and is offered to him on a card showing it, with Start
        step N; only his tap opens it, and then the specialist builds the step's change from the script
        itself, on a card for his Approve (start_step). Cain alone can't make a request the run's, and no
        handover is ever the run's (a handover only ever reads his own messages). "conformance-gmail" and
        "conformance-family" run here and now (conformance): they touch only events the run makes for them
        and take no request."""
        run = smoke_run(self.ledger)
        problem = self.run_problem(run, run_id)
        if problem:
            return "refused", problem[:1].upper() + problem[1:] + ". Nothing changed.", {}
        if not step:
            return ("refused", "Name the step: keeper.sh fastpath smoke-step <run id> <step>, a short name of "
                               "lowercase letters, digits and dashes. Nothing changed.", {})
        if step.startswith(CONFORMANCE + "-") or step == CONFORMANCE:
            provider = step[len(CONFORMANCE) + 1:]
            if provider not in SMOKE_PROVIDERS:
                return "refused", "The conformance step is conformance-gmail or conformance-family. Nothing changed.", {}
            return self.conformance(run, provider)
        checked, why = self.check_script(script or {})
        if checked is None:
            return ("refused", f"Not offered: {why}. A step needs its script: keeper.sh fastpath smoke-step "
                               f"{run_id} {step} <gmail|family> <add|move|remove> <YYYY-MM-DD> <test title> "
                               "[HH:MM-HH:MM]. Nothing changed.", {})
        import secrets
        now = self.ledger.now()
        run = dict(run)
        n = len(run.get("offered") or []) + 1
        entry = {"name": step, "n": n, "script": checked, "at": iso(now), "nonce": secrets.token_hex(8),
                 "expires": iso(now + timedelta(seconds=SMOKE_STEP_TTL_S))}
        run["step"] = entry                       # offered, not open: only his Start step tap opens it
        run.setdefault("offered", []).append({"name": step, "n": n, "at": iso(now)})
        words = self._script_words(checked)
        with self.ledger.tx() as db:
            self.ledger.set_meta(SMOKE_RUN, json.dumps(run), db)
            self.ledger.event("calendar_smoke_step_offered", {"run": run["id"], "step": step, "n": n}, db=db)
            nonce = choices.mint(self.ledger, kind="calendar_change_step_start", target=f"{run['id']}:{n}",
                                 chat_id=self.chat_id, ttl_s=SMOKE_STEP_TTL_S, db=db)
            self._say(db, self.chat_id, None,
                      f"<b>Check after installing, step {n}</b> ({_safe(step)}). Start step {n} puts this test "
                      f"change on a card for your Approve: {render.escape(words)}. It's built from this script "
                      "by Harness itself, not from any message. Nothing changes until you approve that card.",
                      buttons=[[(f"Start step {n}", choices.callback_data(nonce))]],
                      binds=[{"type": "choice", "nonce": nonce}])
        return ("ok", f"Step {n} ({step}) of smoke run {run['id']} is offered to him on a card showing its script: "
                      f"{words}. Once he taps Start step {n} (within {SMOKE_STEP_TTL_S // 60} minutes), its change "
                      "comes on a card built from that script, for his Approve. Don't hand anything over for it: "
                      "a handover is always an ordinary request.",
                {"run": run["id"], "step": step, "n": n, "script": checked})

    def check_script(self, script: dict) -> tuple[dict | None, str]:
        """A step's script, checked strictly (tenth round): calendar gmail or family; kind add, move or
        remove; a test title of plain words; a day from yesterday to 60 days on; for an add or a move, a
        start and end time. (the script, "") or (None, why)."""
        if not isinstance(script, dict):
            return None, "the step has no script"
        cal, kind = str(script.get("calendar") or ""), str(script.get("kind") or "")
        title = str(script.get("title") or "").strip()
        if cal not in SMOKE_PROVIDERS:
            return None, "its calendar must be gmail or family"
        if kind not in ("add", "move", "remove"):
            return None, "its kind must be add, move or remove"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 '&.,:-]{0,59}", title):
            return None, "its test title must be plain words, up to 60 characters"
        try:
            day = date.fromisoformat(str(script.get("day") or ""))
        except ValueError:
            return None, "its day must be YYYY-MM-DD"
        today = self._today()
        if not today - timedelta(days=1) <= day <= today + timedelta(days=60):
            return None, "its day must be from yesterday to 60 days on"
        out = {"calendar": cal, "kind": kind, "title": title.removeprefix(SMOKE_PREFIX), "day": day.isoformat()}
        if kind in ("add", "move"):
            got = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)", str(script.get("times") or ""))
            if not got or got.group(1) + got.group(2) >= got.group(3) + got.group(4):
                return None, "an add or a move needs its times as HH:MM-HH:MM, the end after the start"
            out["times"] = got.group(0)
        return out, ""

    def _script_change(self, script: dict) -> dict:
        """The step's change, as the specialist's own request (tenth round): built from the script alone."""
        zone = ZoneInfo(self.tz)
        day = date.fromisoformat(script["day"])
        start = end = ""
        if script.get("times"):
            a, b = script["times"].split("-")
            start = datetime.combine(day, datetime.strptime(a, "%H:%M").time(), zone).isoformat()
            end = datetime.combine(day, datetime.strptime(b, "%H:%M").time(), zone).isoformat()
        return {"calendar": script["calendar"], "op": script["kind"], "title": script["title"],
                "dates": "" if script["kind"] == "add" else day.isoformat(), "start": start, "end": end,
                "days": "", "until": "", "location": ""}

    def _script_words(self, script: dict) -> str:
        what = {"add": "add", "move": "move", "remove": "remove"}[script["kind"]]
        title = (SMOKE_PREFIX if script["kind"] == "add" else "") + script["title"]
        day = date.fromisoformat(script["day"])
        when = f" to {script['times'].replace('-', ' to ')}" if script["kind"] == "move" else \
            f" at {script['times'].replace('-', ' to ')}" if script.get("times") else ""
        return (f"{provider_name(script['calendar'])}: {what} \u201c{title}\u201d on {_day_words(day)}{when}")

    def start_step(self, target: str) -> str:
        """His Start step N (tenth round): the step opens and takes the request Harness builds from its
        script, the change family the run's (tagged, let go, judged). Single use, while the run is live."""
        run_id, _, n = target.partition(":")
        run = smoke_run(self.ledger)
        problem = self.run_problem(run, run_id)
        step = run.get("step") or {}
        if problem:
            return "That check after installing is over, so nothing was started."
        try:
            fresh = self.ledger.now() < datetime.fromisoformat(step["expires"])
        except (KeyError, ValueError, TypeError):
            fresh = False
        if str(step.get("n")) != n or step.get("job") or not fresh or self.script_card is None:
            return "That step isn't waiting any more, so nothing was started."
        script = step["script"]
        params = {"changes": [self._script_change(script)]}
        text = f"Smoke test step {step['n']} ({step['name']}), from its script: {self._script_words(script)}"

        def own(job_id: str, db) -> None:
            taken = dict(step, job=job_id, opened=iso(self.ledger.now()))
            live = dict(smoke_run(self.ledger), step=taken)
            live.setdefault("steps", []).append({"name": step["name"], "n": step["n"], "job": job_id,
                                                 "at": iso(self.ledger.now())})
            self.ledger.set_meta(SMOKE_RUN, json.dumps(live), db)
            self.ledger.set_meta(f"{SMOKE_OWN}{job_id}", json.dumps({"run": run_id, "step": step["name"],
                                                                    "nonce": step.get("nonce", ""),
                                                                    "at": iso(self.ledger.now())}), db)
            self.ledger.event("calendar_smoke_step_taken", {"run": run_id, "step": step["name"], "job": job_id},
                              db=db)
        try:
            job = self.script_card(self.chat_id, text, params, own)
        except (Refuse, ValueError, KeyError, TypeError) as e:
            log.warning("a smoke step's card couldn't be made: %s", type(e).__name__)
            return "That step's card couldn't be made, so nothing was started."
        log.info("smoke run %s: step %s started on his tap, request %s", run_id, step["name"], render.short(job))
        return f"Step {step['n']} started: its card follows."

    def owned_run(self, job_id: str) -> str:
        """The smoke run a request belongs to (ninth round): only one a step of the run took, through its
        change family's root. "" for every other request, whenever it came."""
        if not job_id:
            return ""
        for jid in dict.fromkeys([job_id, self.ledger.get_meta(f"job_parent:{job_id}") or job_id]):
            got = _meta_json(self.ledger, f"{SMOKE_OWN}{jid}")
            if got.get("run"):
                return str(got["run"])
        return ""

    def _step_nonce(self, p) -> str:
        """The nonce of the step that took this request (tenth round), "" when none."""
        try:
            job_id = p["job_id"]
        except (KeyError, TypeError, IndexError):
            return ""
        for jid in dict.fromkeys([job_id, self.ledger.get_meta(f"job_parent:{job_id}") or job_id]):
            got = _meta_json(self.ledger, f"{SMOKE_OWN}{jid}")
            if got.get("run"):
                return str(got.get("nonce") or "")
        return ""

    def _smoke_tag(self, p) -> str:
        """The smoke run a change belongs to (ninth round): the live run, only when a step of it took this
        request (owned_run). A request that merely arrived while the run was live is never the run's."""
        run = self.live_run()
        if not run:
            return ""
        try:
            return run["id"] if self.owned_run(p["job_id"]) == run["id"] else ""
        except (KeyError, TypeError, IndexError):
            return ""

    def _note_created(self, run_id: str, entry: dict, db=None) -> None:
        """An event the run itself is creating, kept by id before the write goes out (ninth round): the
        only events its leftover cleanup may ever take off."""
        x = {"cal": entry.get("cal", "")}
        if entry.get("id"):
            x["id"] = entry["id"]
        if entry.get("href"):
            x["href"] = entry["href"]
        if x["cal"] not in SMOKE_PROVIDERS or len(x) < 2:
            return
        for k in ("nonce", "day", "until"):     # tenth round: found by its exact nonce if not by its id
            if entry.get(k):
                x[k] = str(entry[k])
        try:
            got = json.loads(self.ledger.get_meta(SMOKE_CREATED + run_id) or "[]")
        except ValueError:
            got = []
        if x in got:
            return
        got.append(x)
        if db is not None:
            self.ledger.set_meta(SMOKE_CREATED + run_id, json.dumps(got), db)
        else:
            with self.ledger.tx() as d:
                self.ledger.set_meta(SMOKE_CREATED + run_id, json.dumps(got), d)

    def _smoke_days(self, c: dict) -> dict:
        """Eleventh round: the day a run's event is on, in his time zone (not the day its UTC time falls on),
        and for a series its last day ("until", or as far as a series is looked for), so a search by nonce
        covers it all."""
        raw = str(c.get("start") or c.get("dates") or "")
        try:
            when = _when(raw)
            day = when.astimezone(ZoneInfo(self.tz)).date() if isinstance(when, datetime) and when.tzinfo \
                else (when.date() if isinstance(when, datetime) else when)
        except (ValueError, TypeError, AttributeError):
            return {"day": raw[:10]}
        out = {"day": day.isoformat()}
        if c.get("op") == "add_series":
            try:
                last = date.fromisoformat(str(c.get("until") or "")[:10])
            except ValueError:
                last = day + END_AHEAD
            out["until"] = max(day, last).isoformat()
        return out

    def created_by(self, run_id: str) -> list[dict]:
        try:
            got = json.loads(self.ledger.get_meta(SMOKE_CREATED + run_id) or "[]")
        except ValueError:
            return []
        return [x for x in got if isinstance(x, dict)]

    # -- the conformance item (ninth and tenth rounds) ---------------------------------------------
    def conformance(self, run: dict, provider: str) -> tuple[str, str, dict]:
        """Whether the calendar refuses every write kind the specialist sends with a stale version (ninth and
        tenth rounds). The run makes its own test events and writes only to them: an edit of a one-off with
        the version it had just read (the fresh edit, which must go through), then an edit sent with the
        version from before that (a counter in the note, so its body differs from both earlier versions),
        a removal sent with that same out of date version, and on its own short series an edit of one day,
        fresh then stale. A write kind counts as enforced only when the calendar gave its documented stale
        answer (412, or Gmail's 409 for that case) and a read afterwards shows the stale write wasn't
        applied; any other answer is unknown (CONFORMANCE_KINDS). The gate opens only when all three are
        enforced. A refused fresh edit means the specialist and the calendar don't agree on versions:
        said plainly, with Test again, and no override (open_gate). (status, said, extra)."""
        run_id = run["id"]
        name = provider_name(provider)
        zone = ZoneInfo(self.tz)
        start = (self.ledger.now().astimezone(zone) + timedelta(days=1)).replace(hour=3, minute=0, second=0,
                                                                                 microsecond=0)
        end = start + timedelta(minutes=15)
        title = SMOKE_PREFIX + "safety check"
        import secrets
        nonce = secrets.token_hex(8)
        try:
            got = (self._conform_gmail if provider == "gmail" else self._conform_family)(run_id, nonce, title,
                                                                                      start, end)
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable) as e:
            got = {"kinds": {}, "why": f"the test couldn't be made ({type(e).__name__})"}
        kinds = got.get("kinds") or {}
        result = _conformance_result(kinds)
        fresh_failed = any(kinds.get(k) == "incompatible" for k in CONFORMANCE_KINDS)
        now = iso(self.ledger.now())
        record = {"result": result, "kinds": kinds, "at": now, "run": run_id, "why": got.get("why", ""),
                  "answers": got.get("answers", {}), "fresh_failed": fresh_failed,
                  "id": got.get("id", ""), "cleared": bool(got.get("cleared")),
                  # Twelfth round: the strength of the versions it read, and on Family a PUT with no If-Match.
                  "etag_strength": _strength(got.get("etags") or []),
                  # Thirteenth round: what this calendar rewrites on a write that changes nothing (_baseline_family).
                  "baseline": got.get("baseline"),
                  # Fifteenth round: the zone names it writes, as written and as IANA names.
                  "zone_form": got.get("zone_form"),
                  **({"unguarded_put": got.get("unguarded_put", "")} if provider == "family" else {})}
        gate = card_gate(self.ledger)
        run = dict(smoke_run(self.ledger))
        run.setdefault("conformance", {})[provider] = record
        opened = False
        with self.ledger.tx() as db:
            self.ledger.set_meta(SMOKE_RUN, json.dumps(run), db)
            if gate:
                gate.setdefault("conformance", {})[provider] = record
                opened = result == "enforced" and self._maybe_open(gate, provider, now)
                self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
            self.ledger.event("calendar_smoke_conformance", {"run": run_id, "calendar": provider, "result": result,
                                                             "kinds": kinds}, db=db)
            waiting = gate and not (gate.get("verified") or {}).get(provider) \
                and not (gate.get("override") or {}).get(provider)
            if waiting and result in ("ignored", "partial"):
                self._tell_unprotected(db, provider, result)
            elif waiting and fresh_failed:
                self._tell_incompatible(db, provider, record)
        log.info("smoke run %s: conformance on %s: %s %s%s", run_id, provider, result, kinds,
                 f" ({got['why']})" if got.get("why") else "")
        if opened:
            log.info("the card gate on %s is open: a fenced edit, a series-day edit and the conformance item", provider)
        extra = {"run": run_id, "calendar": provider, "result": result, "kinds": kinds}
        if result == "enforced":
            return ("ok", f"Conformance on {name}: it refused an edit, a removal and an edit of one day of a series, "
                          "each sent with an out of date version of the run's own test events, and a read showed "
                          "none of them applied, as it should." + (f" {name} cards are open now." if opened else ""),
                    extra)
        if result == "ignored":
            return ("refused", f"Conformance on {name}: it accepted a write sent with an out of date version, so it "
                               f"doesn't protect against concurrent edits. {name} cards stay held; he has a message "
                               "saying so, with Open cards without the check. Leave that to him.", extra)
        if result == "partial":
            return ("refused", f"Conformance on {name}: it refused out of date edits but not an out of date removal, "
                               f"so removals there aren't protected. {name} cards stay held, and removals stay held "
                               "even after an override; he has a message saying so. Leave that to him.", extra)
        if fresh_failed:
            return ("refused", f"Conformance on {name}: {name} turned down the run's fresh edit, sent with the version "
                               f"it had just given ({_answer_words(record['answers'])}). The specialist and {name} "
                               "don't agree on versions, so every guarded change there would be turned down. He has "
                               f"a message with Test again; run keeper.sh fastpath smoke-step {run_id} "
                               f"conformance-{provider} again once that's looked at. gate-open is refused for it.",
                    extra)
        return ("refused", f"Conformance on {name} couldn't be told: {got.get('why') or _answer_words(record['answers'])}."
                           f" {name} cards stay held. Run keeper.sh fastpath smoke-step {run_id} conformance-{provider} "
                           "again.", extra)

    def _tell_unprotected(self, db, provider: str, result: str) -> None:
        """His message when the conformance item found a calendar takes a stale write (ignored: eleventh
        round, the specialist can't change it safely, _tell_cannot_protect), or a stale removal (partial):
        what it risks, with Open cards without the check (logged)."""
        if result == "ignored":
            self._tell_cannot_protect(db, provider, "ignored")
            return
        name = provider_name(provider)
        nonce = choices.mint(self.ledger, kind="calendar_change_gate_open", target=provider,
                             chat_id=self.chat_id, ttl_s=TURN_OFF_TTL_S, db=db)
        text = (f"<b>{name} doesn't protect removals against edits made at the same time.</b> During the "
                f"check after installing, {name} refused out of date edits of the check's own test events, "
                "but took a removal sent with an out of date version. Calendar cards for "
                f"{name} stay waiting with no Approve. Open cards without the check lets moves and adds "
                f"through; removals on {name} stay waiting even then, since one could take off an event "
                "someone changed in between. That tap is kept in the log.")
        self._say(db, self.chat_id, None, text, buttons=[[("Open cards without the check", choices.callback_data(nonce))]],
                  binds=[{"type": "choice", "nonce": nonce}])

    def _tell_incompatible(self, db, provider: str, record: dict) -> None:
        """Tenth round: the calendar turned down the check's fresh edit. Eleventh round: told as a calendar
        the specialist can't change safely (_tell_cannot_protect), with Test again as well."""
        self._tell_cannot_protect(db, provider, "incompatible", record=record)

    def cannot_protect(self, provider: str) -> bool:
        """Eleventh round: the conformance item found this calendar incompatible (it turned down a fresh
        edit) or ignoring stale writes, and he hasn't opened it."""
        gate = card_gate(self.ledger)
        rec = (gate.get("conformance") or {}).get(provider) or {}
        if not gate or (gate.get("override") or {}).get(provider) or (gate.get("verified") or {}).get(provider):
            return False
        return rec.get("result") == "ignored" or bool(rec.get("fresh_failed"))

    def _tell_cannot_protect(self, db, provider: str, kind: str, record: dict | None = None,
                             seen_in: str = "") -> None:
        """Eleventh round: once per install and calendar, in plain words: the specialist can't change this
        calendar safely, and he can edit it by hand; each request held for it is passed back, ready to copy;
        and Open without protection (open_gate) lets changes there go as a read-compare-write, every receipt
        labelled unprotected. Never a dead end: that button is always offered."""
        gate = card_gate(self.ledger)
        told = gate.setdefault("cannot_told", {})
        if told.get(provider):
            return
        told[provider] = iso(self.ledger.now())
        self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
        name = provider_name(provider)
        if kind == "incompatible":
            why = (f"{name} turned down an edit of a test event that was sent with the version {name} had just "
                   f"given for it ({_answer_words((record or {}).get('answers') or {})}), so every protected "
                   "change there would be turned down the same way")
        elif seen_in:
            why = (f"{seen_in} changed an event on {name} and left its version as it was, so {name} would also "
                   "take a change sent with an out of date version")
        else:
            why = (f"during the check after installing, {name} accepted a change sent with an out of date version "
                   "of a test event, so it won't refuse a change that would overwrite an edit made elsewhere")
        nonce = choices.mint(self.ledger, kind="calendar_change_gate_open", target=provider,
                             chat_id=self.chat_id, ttl_s=TURN_OFF_TTL_S, db=db)
        rows = [[("Open without protection", choices.callback_data(nonce))]]
        binds = [{"type": "choice", "nonce": nonce}]
        again = ""
        if kind == "incompatible":
            n2 = choices.mint(self.ledger, kind="calendar_change_conform_again", target=provider,
                              chat_id=self.chat_id, ttl_s=SMOKE_TTL_S, db=db)
            rows.append([("Test again", choices.callback_data(n2))])
            binds.append({"type": "choice", "nonce": n2})
            again = " Test again runs that test once more."
        lines = [f"<b>Harness can't change {name} safely.</b> {render.escape(why)}. So Harness won't change "
                 f"{name} for now, and you can make changes there by hand in the calendar app.",
                 f"Open without protection lets Harness change {name} anyway: each change is read just before "
                 "it's written and compared with your card, but it's sent without the calendar's own version "
                 f"check, so edits made at the same time by someone else can be overwritten or deleted. It "
                 f"opens {name} only, not your other calendar. Every card and receipt for {name} then says "
                 "Unprotected, and that tap is kept in the log." + again]
        held = self._pass_back_lines(provider, db)
        if held:
            lines.append(f"Waiting for {name}, ready to copy into the calendar app:")
            lines += held
        self._say(db, self.chat_id, None, "\n".join(lines), buttons=rows, binds=binds)
        self.ledger.event("calendar_cannot_protect", {"calendar": provider, "kind": kind, "held": len(held)}, db=db)

    def _pass_back_lines(self, provider: str, db, pids: list[str] | None = None) -> list[str]:
        """Each request held for this calendar (or just `pids`), as a ready-to-copy summary, passed back once
        (eleventh round): it stays held, so Open without protection still brings it back on a card."""
        out = []
        for pid, held, p in self._held_rows():
            if provider not in (held.get("providers") or []) or (pids is not None and pid not in pids):
                continue
            if self.ledger.get_meta(f"{PASSED_BACK}{pid}") is not None:
                continue
            try:
                changes = json.loads(p["params_json"])["changes"]
            except (ValueError, KeyError, TypeError):
                continue
            self.ledger.set_meta(f"{PASSED_BACK}{pid}", iso(self.ledger.now()), db)
            for c in changes:
                out.append("• " + render.escape(_copy_line(c, self.tz)))
        return out

    def conform_again(self, provider: str) -> str:
        """His Test again (tenth round): that conformance step once more, under the live smoke run."""
        if provider not in SMOKE_PROVIDERS:
            return "Nothing changed."
        run = self.live_run()
        if not run:
            return "The check after installing isn't running now, so nothing was checked. Cain starts it again."
        status, said, _ = self.conformance(run, provider)
        name = provider_name(provider)
        if status == "ok":
            return f"Checked again: {name} refused every out of date write, as it should."
        return f"Checked again on {name}: still not passed. " + render.plain(said).split(". ", 1)[-1]

    def _tag_ok(self, run_id: str, nonce: str, tag: str, got_nonce: str) -> bool:
        return tag == run_id and (not nonce or got_nonce == nonce)

    def _conform_gmail(self, run_id: str, nonce: str, title: str, start: datetime, end: datetime) -> dict:
        import secrets
        address = self._gmail_address()
        uid, sid = "cm" + secrets.token_hex(16), "cm" + secrets.token_hex(16)
        private = {SMOKE_PROP: run_id, SMOKE_NONCE_PROP: nonce}
        side = lambda t: {k: v for k, v in self._gmail_side(t).items() if v}   # noqa: E731
        kinds: dict = {}
        answers: dict = {}
        got: dict = {"id": uid, "kinds": kinds, "answers": answers}
        when = start.astimezone(timezone.utc) + timedelta(days=1)
        inst = f"{sid}_{when:%Y%m%dT%H%M%SZ}"

        etags: list = got.setdefault("etags", [])   # twelfth round: each version read, for its strength

        def desc(ident: str) -> tuple[str, dict | None]:
            kind, ev = self.google.look(address, ident)
            gone = kind == "gone" or (kind == "ok" and (ev or {}).get("status") == "cancelled")
            if kind == "ok" and not gone:
                etags.append((ev or {}).get("etag") or "")
            return ("gone" if gone else kind), ev

        def stale_kind(label: str, ident: str, fresh_body: dict, stale_body: dict, mark: str) -> str:
            kind, ev = desc(ident)
            old = (ev or {}).get("etag") or ""
            if kind != "ok" or not old:
                kinds[label] = "unknown"
                answers[label] = "its test event couldn't be read back"
                return ""
            out = self.google.change(address, ident, fresh_body, old)
            if out.kind != "ok":
                kinds[label] = "incompatible"
                answers[label] = _out_words(out, "the fresh edit")
                return old
            kind, ev = desc(ident)
            if kind == "ok" and (ev or {}).get("etag") == old:
                kinds[label] = "ignored"
                answers[label] = "the event's version didn't change when it was edited"
                return old
            out = self.google.change(address, ident, stale_body, old)
            kind, ev = desc(ident)
            applied = kind == "ok" and mark in str((ev or {}).get("description") or "")
            kinds[label] = _classify("gmail", out, applied, kind == "ok")
            answers[label] = _out_words(out, "the out of date edit")
            return old

        self._note_created(run_id, {"cal": "gmail", "id": uid, "nonce": nonce, "day": start.date().isoformat()})
        self._note_created(run_id, {"cal": "gmail", "id": sid, "nonce": nonce, "day": start.date().isoformat(),
                                    "until": (start + timedelta(days=2)).date().isoformat()})
        try:
            out = self.google.insert(address, {"id": uid, "summary": title, "status": "confirmed",
                                               "transparency": "transparent", "start": side(start), "end": side(end),
                                               "extendedProperties": {"private": dict(private)}})
            if out.kind != "ok":
                return {**got, "why": "its test event couldn't be added"}
            self._zone_form = None
            got["baseline"] = self._baseline_gmail(address, uid, desc)     # thirteenth round
            got["zone_form"] = self._zone_form
            old = stale_kind("edit", uid, {"description": f"{CONFORM_MARK} 1"},
                             {"description": f"{CONFORM_MARK} 2"}, f"{CONFORM_MARK} 2")
            if kinds.get("edit") in ("enforced", "ignored") and old:
                # The removal is sent with the version from before both edits: out of date.
                out = self.google.drop(address, uid, old)
                kind, ev = desc(uid)
                kinds["remove"] = _classify("gmail", out, kind == "gone", kind in ("ok", "gone"))
                answers["remove"] = _out_words(out, "the out of date removal")
            out = self.google.insert(address, {"id": sid, "summary": title, "status": "confirmed",
                                               "transparency": "transparent", "start": side(start), "end": side(end),
                                               "recurrence": ["RRULE:FREQ=DAILY;COUNT=3"],
                                               "extendedProperties": {"private": dict(private)}})
            if out.kind != "ok":
                kinds.setdefault("instance", "unknown")
                answers["instance"] = "its test series couldn't be added"
            else:
                stale_kind("instance", inst, {"description": f"{CONFORM_MARK} 3"},
                           {"description": f"{CONFORM_MARK} 4"}, f"{CONFORM_MARK} 4")
            return got
        finally:
            cleared = True
            for ident in (uid, inst, sid):
                kind, ev = desc(ident)
                if kind != "ok" or not ev:
                    continue
                tags = (ev.get("extendedProperties") or {}).get("private") or {}
                if self._tag_ok(run_id, nonce, tags.get(SMOKE_PROP), tags.get(SMOKE_NONCE_PROP, "")):
                    cleared = self.google.drop(address, ident, ev.get("etag")).kind == "ok" and cleared
            got["cleared"] = cleared

    def _conform_family(self, run_id: str, nonce: str, title: str, start: datetime, end: datetime) -> dict:
        import secrets
        uid, sid = "hm-" + secrets.token_hex(16), "hm-" + secrets.token_hex(16)
        href, shref = self.client.href_for(uid), self.client.href_for(sid)
        tag = f"X-HARNESS-SMOKE:{run_id}\r\nX-HARNESS-SMOKE-NONCE:{nonce}\r\nEND:VEVENT"
        one = ics_edit.build(uid, title, start, end, "", "", self.tz, self.ledger.now()).replace("END:VEVENT", tag, 1)
        series = ics_edit.build(sid, title, start, end, "", "FREQ=DAILY;COUNT=3", self.tz,
                                self.ledger.now()).replace("END:VEVENT", tag, 1)
        kinds: dict = {}
        answers: dict = {}
        got: dict = {"id": href, "kinds": kinds, "answers": answers}
        day2 = start.astimezone(timezone.utc) + timedelta(days=1)
        etags: list = got.setdefault("etags", [])   # twelfth round: each version read, for its strength
        fetch_ = self.client.fetch

        def fetch(at: str):
            back, body = fetch_(at)
            if back.kind == "ok":
                etags.append(back.etag or "")
            return back, body

        def note(body: str, words: str) -> str:
            return body.replace("END:VEVENT", f"DESCRIPTION:{words}\r\nEND:VEVENT", 1)

        def override(body: str, words: str) -> str:
            stamp = f"{self.ledger.now().astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
            ev = "\r\n".join(["BEGIN:VEVENT", f"UID:{sid}", f"DTSTAMP:{stamp}",
                              f"RECURRENCE-ID:{day2:%Y%m%dT%H%M%SZ}", f"DTSTART:{day2:%Y%m%dT%H%M%SZ}",
                              f"DTEND:{day2 + (end - start):%Y%m%dT%H%M%SZ}", f"SUMMARY:{ics_edit._esc(title)}",
                              f"DESCRIPTION:{words}", "END:VEVENT", "END:VCALENDAR"])
            return body.replace("END:VCALENDAR", ev, 1)

        def stale_kind(label: str, at: str, fresh: Callable[[str], str], stale: Callable[[str], str],
                       mark: str) -> str:
            back, body = fetch(at)
            old = back.etag or ""
            if back.kind != "ok" or not old or "END:VEVENT" not in (body or ""):
                kinds[label] = "unknown"
                answers[label] = "its test event couldn't be read back"
                return ""
            out = self.client.replace(at, old, fresh(body))
            if out.kind != "ok":
                kinds[label] = "incompatible"
                answers[label] = _out_words(out, "the fresh edit")
                return old
            back, _ = fetch(at)
            if back.kind == "ok" and (back.etag or "") == old:
                kinds[label] = "ignored"
                answers[label] = "the event's version didn't change when it was edited"
                return old
            out = self.client.replace(at, old, stale(body))
            back, now = fetch(at)
            applied = back.kind == "ok" and mark in (now or "")
            kinds[label] = _classify("family", out, applied, back.kind == "ok")
            answers[label] = _out_words(out, "the out of date edit")
            return old

        day = start.date().isoformat()
        pid_ = "hm-" + secrets.token_hex(16)
        phref = self.client.href_for(pid_)
        # Thirteenth round: the PUT with no If-Match goes to a test event of its own far in the past, with no
        # alarm and a title that says what it is, so it can't remind anyone or sit in the week ahead.
        past = UNGUARDED_AT
        plain = _no_alarm(ics_edit.build(pid_, UNGUARDED_TITLE, past, past + timedelta(minutes=15), "", "", self.tz,
                                         self.ledger.now())).replace("END:VEVENT", tag, 1)
        self._note_created(run_id, {"cal": "family", "href": phref, "nonce": nonce, "day": past.date().isoformat()})
        self._note_created(run_id, {"cal": "family", "href": href, "nonce": nonce, "day": day})   # before sending
        self._note_created(run_id, {"cal": "family", "href": shref, "nonce": nonce, "day": day,
                                    "until": (start + timedelta(days=2)).date().isoformat()})
        try:
            # Twelfth round: a PUT with no If-Match, on a test event of its own, as a write opened without
            # protection (or on a weak version) sends it: recorded as taken or refused.
            got["unguarded_put"], answers["unguarded_put"] = self._unguarded_put(phref, plain, fetch,
                                                                                run_id=run_id, nonce=nonce)
            out = self.client.put_new(href, one)
            if out.kind != "ok":
                return {**got, "why": "its test event couldn't be added"}
            self._zone_form = None
            got["baseline"] = self._baseline_family(href, fetch)             # thirteenth round
            got["zone_form"] = self._zone_form
            old = stale_kind("edit", href, lambda b: note(b, f"{CONFORM_MARK} 1"),
                             lambda b: note(b, f"{CONFORM_MARK} 2"), f"{CONFORM_MARK} 2")
            if kinds.get("edit") in ("enforced", "ignored") and old:
                out = self.client.remove_at(href, old)
                back, _ = fetch(href)
                kinds["remove"] = _classify("family", out, back.kind == "gone", back.kind in ("ok", "gone"))
                answers["remove"] = _out_words(out, "the out of date removal")
            out = self.client.put_new(shref, series)
            if out.kind != "ok":
                kinds.setdefault("instance", "unknown")
                answers["instance"] = "its test series couldn't be added"
            else:
                stale_kind("instance", shref, lambda b: override(b, f"{CONFORM_MARK} 3"),
                           lambda b: override(b, f"{CONFORM_MARK} 4"), f"{CONFORM_MARK} 4")
            return got
        finally:
            cleared = True
            for at in (href, shref, phref):
                back, body = fetch(at)
                flat = (body or "").replace("\r\n", "\n")
                if back.kind == "ok" and f"X-HARNESS-SMOKE:{run_id}\n" in flat + "\n" \
                        and f"X-HARNESS-SMOKE-NONCE:{nonce}" in flat:
                    cleared = self.client.remove_at(at, back.etag or "").kind == "ok" and cleared
            self._settle_test(phref, fetch)
            got["cleared"] = cleared

    def _unguarded_put(self, href: str, ics: str, fetch, run_id: str = "", nonce: str = "") -> tuple[str, str]:
        """Twelfth round: on Family, its own test event replaced with no If-Match: "taken" (the replace
        landed and reads back), "refused" (turned down), or "unknown". (result, its answer in words).
        Thirteenth round: the test event is far in the past with no alarm (UNGUARDED_AT, UNGUARDED_TITLE), and
        it's removed and read back gone before the result counts: one that can't be shown gone is "unknown".
        Fourteenth round: its URL (random each run) is kept in the ledger before it's created (created only where
        nothing is, If-None-Match: *, before the PUT with no If-Match), until a read shows it gone; every start
        retries the removal (sweep_test_events)."""
        self._track_test(href, run_id, nonce)
        if self.client.put_new(href, ics).kind != "ok":
            return "unknown", "its test event couldn't be added"
        back, body = fetch(href)
        if back.kind != "ok" or "END:VEVENT" not in (body or ""):
            self._drop_test(href, fetch)
            return "unknown", "its test event couldn't be read back"
        mark = f"{CONFORM_MARK} 0"
        out = self.client.replace(href, None, body.replace("END:VEVENT", f"DESCRIPTION:{mark}\r\nEND:VEVENT", 1))
        back, now = fetch(href)
        if out.kind == "ok" and back.kind == "ok" and mark in (now or ""):
            got = "taken", "a replace with no If-Match was taken and reads back"
        elif out.kind not in ("ok", "unknown"):
            got = "refused", _out_words(out, "a replace with no If-Match")
        else:
            got = "unknown", _out_words(out, "a replace with no If-Match")
        if not self._drop_test(href, fetch):
            return "unknown", got[1] + "; its test event couldn't be shown removed afterwards"
        return got

    def _baseline_family(self, href: str, fetch) -> dict | None:
        """Thirteenth round: what Family rewrites on a write that changes nothing: the run's test event read, written
        back as read (with its version), read again, and the two reads compared. That calendar's baseline for the
        lost-update compare (_check_lost); None when it couldn't be taken."""
        back, body = fetch(href)
        if back.kind != "ok" or "END:VEVENT" not in (body or ""):
            return None
        if self.client.replace(href, back.etag or None, body).kind != "ok":
            return None
        again, now = fetch(href)
        if again.kind != "ok":
            return None
        self._zone_form = zone_forms(body, now)        # fifteenth round: the smoke run records the form
        return _baseline_of(_lost_fields(_ics_fields(body), _ics_fields(body), _ics_fields(now)))

    def _baseline_gmail(self, address: str, uid: str, desc) -> dict | None:
        """The same for Gmail: the event's own fields written back as read (stamps and ids left out)."""
        kind, ev = desc(uid)
        if kind != "ok" or not ev:
            return None
        same = {k: v for k, v in ev.items() if k not in IGNORED_STAMPS["gmail"] and k not in _GMAIL_READ_ONLY}
        if self.google.change(address, uid, same, ev.get("etag")).kind != "ok":
            return None
        kind, now = desc(uid)
        if kind != "ok" or not now:
            return None
        self._zone_form = zone_forms(ev, now)          # fifteenth round: the smoke run records the form
        return _baseline_of(_lost_fields(_gmail_fields(ev), _gmail_fields(ev), _gmail_fields(now)))

    def _drop_test(self, href: str, fetch) -> bool:
        """The unguarded PUT's test event removed and read back gone (thirteenth round). Whether it's gone.
        Fourteenth round: once shown gone it's no longer kept as left (UNGUARDED_LEFT)."""
        back, _ = fetch(href)
        if back.kind == "ok":
            self.client.remove_at(href, back.etag or "")
            back, _ = fetch(href)
        if back.kind == "gone":
            self._untrack_test(href)
        return back.kind == "gone"

    # -- the unguarded PUT's test event, until it's shown gone (fourteenth round) ----------------------------------
    def _tracked_tests(self) -> dict:
        try:
            got = json.loads(self.ledger.get_meta(UNGUARDED_LEFT) or "{}")
        except ValueError:
            return {}
        return got if isinstance(got, dict) else {}

    def _track_test(self, href: str, run_id: str, nonce: str) -> None:
        left = self._tracked_tests()
        left[href] = {"run": run_id, "nonce": nonce, "at": iso(self.ledger.now()), "tries": 0}
        with self.ledger.tx() as db:
            self.ledger.set_meta(UNGUARDED_LEFT, json.dumps(left, sort_keys=True), db)

    def _untrack_test(self, href: str) -> None:
        left = self._tracked_tests()
        if href in left:
            del left[href]
            with self.ledger.tx() as db:
                self.ledger.set_meta(UNGUARDED_LEFT, json.dumps(left, sort_keys=True), db)

    def _settle_test(self, href: str, fetch) -> None:
        """After the conformance item's own cleanup: a test event read back gone is no longer kept as left."""
        if href in self._tracked_tests():
            try:
                back, _ = fetch(href)
            except Exception:                     # noqa: BLE001: kept, and retried at the next start
                return
            if back.kind == "gone":
                self._untrack_test(href)

    def sweep_test_events(self) -> list[dict]:
        """At every start (fourteenth round): each unguarded PUT test event still kept as left is read by its URL;
        gone, it's forgotten; there and still carrying its run's tag and nonce, it's removed with the version just
        read and read again, and forgotten once shown gone. Anything else (no answer, a removal turned down, a
        body without its tag) keeps it, counted, for the next start. What's still left, for the status page."""
        left = self._tracked_tests()
        if not left or self.client is None:
            return test_events_left(self.ledger)
        for href, info in list(left.items()):
            try:
                back, body = self.client.fetch(href)
                if back.kind == "ok":
                    flat = (body or "").replace("\r\n", "\n")
                    if f"X-HARNESS-SMOKE:{info.get('run', '')}\n" in flat + "\n" \
                            and f"X-HARNESS-SMOKE-NONCE:{info.get('nonce', '')}" in flat:
                        self.client.remove_at(href, back.etag or "")
                        back, _ = self.client.fetch(href)
            except Exception as e:                # noqa: BLE001: kept, and retried at the next start
                log.warning("the conformance test event couldn't be read or removed: %s", type(e).__name__)
                back = None
            if back is not None and back.kind == "gone":
                self._untrack_test(href)
                log.info("the conformance test event left from run %s is gone now", info.get("run", ""))
                continue
            got = self._tracked_tests()
            if href in got:
                got[href]["tries"] = int(got[href].get("tries") or 0) + 1
                with self.ledger.tx() as db:
                    self.ledger.set_meta(UNGUARDED_LEFT, json.dumps(got, sort_keys=True), db)
            log.warning("the conformance test event from run %s is still on Family; retried at the next start",
                        info.get("run", ""))
        return test_events_left(self.ledger)

    def _maybe_open(self, gate: dict, provider: str, now: str) -> bool:
        """A calendar's gate opens (ninth round) once the run has read back a fenced edit and a series-day
        edit there and the calendar refused the run's own stale write. Whether it opened now."""
        seen = (gate.get("seen") or {}).get(provider) or {}
        conf = ((gate.get("conformance") or {}).get(provider) or {}).get("result")
        if (gate.get("verified") or {}).get(provider):
            return False
        if seen.get("fenced") and seen.get("series") and conf == "enforced":
            gate.setdefault("verified", {})[provider] = now
            return True
        return False

    def _note_verified(self, plan: dict, rec: dict) -> None:
        """A smoke run's change read back on a calendar (seventh and eighth rounds): what it shows for that
        calendar's gate after an install (closed_providers). A move or removal sent with If-Match counts as
        the fenced edit; one on a day of a series counts as the series-day edit. Both read back, and that
        calendar's cards are no longer held: each held change comes back on a fresh card (release_held)."""
        if not plan.get("smoke"):
            return
        fn = (rec.get("spec") or {}).get("fn", "")
        provider, op = _STEP_FN.get(fn, ("", ""))
        if not provider and fn in ("gmail_end", "family_end"):
            provider, op = fn.split("_")[0], "end"
        gate = card_gate(self.ledger)
        if not provider or not gate or (gate.get("verified") or {}).get(provider):
            return
        now = iso(self.ledger.now())
        seen = gate.setdefault("seen", {}).setdefault(provider, {})
        fenced = op in ("move", "remove", "end") and bool(rec.get("if_match"))
        part = next((pt for pt in plan.get("parts", []) if any(r is rec for r in pt.get("steps", []))), {})
        series = op in ("move", "remove") and any(b.get("recurrence") and b.get("calendar") == provider
                                                  and b.get("scope") == "occurrence" for b in part.get("bound") or [])
        if fenced:
            seen.setdefault("fenced", now)
        if series:
            seen.setdefault("series", now)
        opened = self._maybe_open(gate, provider, now)  # ninth round: the conformance item too
        if not (fenced or series):
            return
        with self.ledger.tx() as db:
            self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
            self.ledger.event("calendar_card_gate_seen", {"calendar": provider, "fenced": fenced, "series": series,
                                                          "open": opened}, db=db)
        if opened:
            log.info("the card gate on %s is open: a fenced edit and a series-day edit read back, and the "
                     "conformance item passed", provider)

    def _gate_blocked(self, plan: dict, rec: dict, stopped: "Stopped") -> None:
        """The calendar refused its own safety check on an event that hadn't changed, during the smoke run
        (eighth round): that calendar's cards stay held, and he's told plainly that edits there are blocked
        and why, with Open cards without the check (logged) for when the check can't complete there."""
        if not plan.get("smoke") or stopped.kind != "fence_refused":
            return
        provider = _STEP_FN.get((rec.get("spec") or {}).get("fn", ""), ("", ""))[0]
        gate = card_gate(self.ledger)
        if not provider or not gate or (gate.get("verified") or {}).get(provider) \
                or (gate.get("blocked") or {}).get(provider):
            return
        name = provider_name(provider)
        gate.setdefault("blocked", {})[provider] = iso(self.ledger.now())
        with self.ledger.tx() as db:
            self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
            self.ledger.event("calendar_card_gate_blocked", {"calendar": provider}, db=db)
            nonce = choices.mint(self.ledger, kind="calendar_change_gate_open", target=provider,
                                 chat_id=self.chat_id, ttl_s=TURN_OFF_TTL_S, db=db)
            self._say(db, self.chat_id, None,
                      f"<b>Edits on {name} are blocked.</b> During the check after installing, {name} turned down "
                      "the safety check while the event hadn't changed at all, so a move or removal there can't be "
                      "guarded against someone else's edit in between. Calendar cards for "
                      f"{name} wait with no Approve until a later check passes there. Open cards without the check "
                      f"lets {name} cards through anyway, each still with its receipt and Undo, and that tap is "
                      "kept in the log.",
                      buttons=[[("Open cards without the check", choices.callback_data(nonce))]],
                      binds=[{"type": "choice", "nonce": nonce}])
        log.warning("the card gate on %s stays closed: the calendar refused the safety check on an unchanged event "
                    "during the smoke run", provider)

    def _version_unmoved(self, provider: str, what: str = "a write") -> None:
        """Tenth round: seen in normal operation, a write the calendar took left the event's version as it
        was, so a write sent with that version later would be taken too: the calendar no longer protects
        against edits made at the same time. A calendar the conformance item found enforcing after this
        install closes its gate again (its verified mark and any override come off), and he gets the
        same message as when the item finds that, with Open cards without the check. Once per install."""
        if self._unprotected(provider) or (self._recording is not None and self._recording[2].get("rcw")):
            # Twelfth round: only where the calendar is meant to be protected and the write carried If-Match.
            # A calendar he opened without protection, and any read-compare-write, never re-closes the gate.
            return
        gate = card_gate(self.ledger)
        rec = (gate.get("conformance") or {}).get(provider) or {}
        if not gate or rec.get("result") != "enforced":
            return
        now = iso(self.ledger.now())
        gate["conformance"][provider] = {**rec, "result": "ignored", "seen_in_use": now, "write": what,
                                         "why": f"{what} changed the event and left its version unchanged"}
        (gate.get("verified") or {}).pop(provider, None)
        (gate.get("override") or {}).pop(provider, None)
        with self.ledger.tx() as db:
            self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
            self.ledger.event("calendar_card_gate_reclosed", {"calendar": provider, "write": what}, db=db)
            self._tell_cannot_protect(db, provider, "ignored", seen_in=what)
        log.warning("the card gate on %s closed again: %s changed the event in normal use and left its version "
                    "unchanged, so it would take a stale write", provider, what)

    def open_gate(self, provider: str, by: str) -> str:
        """His Open cards without the check, or Cain's keeper.sh fastpath gate-open (eighth round): that
        calendar's gate opens without the check, logged with who and when, and its held changes come back
        on fresh cards. The no-card paths stay off."""
        if provider not in SMOKE_PROVIDERS:
            return "Name Gmail or Family."
        name = provider_name(provider)
        gate = card_gate(self.ledger)
        if provider not in closed_providers(self.ledger):
            return f"{name} cards aren't waiting for the check, so nothing changed."
        record = (gate.get("conformance") or {}).get(provider) or {}
        unprotected = record.get("result") == "ignored" or bool(record.get("fresh_failed"))
        if unprotected and by == "cain":
            # Eleventh round: Open without protection is his tap alone, and never refused outright: Cain's
            # gate-open on such a calendar sends him that card again.
            with self.ledger.tx() as db:
                gate = card_gate(self.ledger)
                (gate.get("cannot_told") or {}).pop(provider, None)
                self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
                self._tell_cannot_protect(db, provider, "incompatible" if record.get("fresh_failed") else "ignored",
                                          record=record, seen_in=record.get("write", ""))
                self.ledger.event("calendar_card_gate_unprotected_asked", {"calendar": provider, "by": by}, db=db)
            return (f"{name} can't be changed safely by Harness, so opening it is his call: he has a card with Open "
                    f"without protection, which lets changes there go unprotected, each receipt saying so. Nothing "
                    "changed yet.")
        if unprotected:
            gate.setdefault("override", {})[provider] = {"by": by, "at": iso(self.ledger.now()), "unprotected": True}
            with self.ledger.tx() as db:
                self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
                self.ledger.event("calendar_card_gate_override", {"calendar": provider, "by": by,
                                                                  "unprotected": True}, db=db)
            log.warning("%s opened without protection, by %s: its writes go as read-compare-write with no If-Match",
                        provider, by)
            held = self.release_held()
            return (f"{name} is open without protection, as you asked; that's kept in the log. Each change there "
                    "is read just before it's written and compared with your card, then sent without the "
                    "calendar's version check, so edits made at the same time by someone else can be overwritten "
                    f"or deleted. Only {name} is opened, and its cards and receipts say Unprotected. "
                    + (f"{held} waiting change{'s' * (held != 1)} came back on a fresh card for your tap."
                       if held else "Nothing was waiting."))
        gate.setdefault("override", {})[provider] = {"by": by, "at": iso(self.ledger.now())}
        with self.ledger.tx() as db:
            self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
            self.ledger.event("calendar_card_gate_override", {"calendar": provider, "by": by}, db=db)
        log.warning("the card gate on %s opened without the check after installing, by %s", provider, by)
        held = self.release_held()
        # Ninth round: on a calendar the conformance item showed takes a stale write, the override says so.
        risk = (f" {name} accepted a write sent with an out of date version during the check, so edits there may "
                "overwrite changes made elsewhere between your card and your tap."
                if conformance_of(self.ledger, provider) == "ignored" else
                f" Removals on {name} still wait: during the check after installing, {name} took a removal sent with an out of date "
                "version, so a removal there could take off an event someone changed in between."
                if removals_unprotected(self.ledger, provider) else "")
        return (f"{name} cards are open without the check after installing, as you asked; that's kept in the log."
                + risk + " "
                + (f"{held} waiting change{'s' * (held != 1)} came back on a fresh card for your tap."
                   if held else "Nothing was waiting."))

    def providers_of(self, params: dict, bound: list | None = None) -> list[str]:
        """The calendars a change writes to: each change's own, and any copy its card bound."""
        out = []
        for c in params.get("changes") or []:
            cal = c.get("calendar")
            if cal in SMOKE_PROVIDERS and cal not in out:
                out.append(cal)
        for b in bound or []:
            if b.get("calendar") in SMOKE_PROVIDERS and b["calendar"] not in out:
                out.append(b["calendar"])
        return out

    def held_by_gate(self, params: dict, bound: list | None = None, job_id: str = "") -> list[str]:
        """The calendars a new card would be held for (eighth and ninth rounds): those of its change whose
        gate is closed. Only a request a step of the live smoke run took (owned_run) goes through; a closed
        gate holds every other request, live run or not."""
        closed = closed_providers(self.ledger)
        removals = [p for p in SMOKE_PROVIDERS if removals_unprotected(self.ledger, p)]
        if not closed and not removals:
            return []
        run = self.live_run()
        if run and job_id and self.owned_run(job_id) == run["id"]:
            return []
        out = [p for p in self.providers_of(params, bound) if p in closed]
        for c in params.get("changes") or []:     # tenth round: removals where stale removals weren't refused
            if c.get("op") == "remove" and c.get("calendar") in removals and c["calendar"] not in out:
                out.append(c["calendar"])
        return out

    def note_held(self, pid: str, job_id: str, providers: list[str], db) -> None:
        self.ledger.set_meta(f"{HELD}{pid}", json.dumps({"job": job_id, "providers": providers,
                                                        "at": iso(self.ledger.now())}), db)
        self.ledger.event("calendar_change_held", {"proposal": pid, "calendars": providers}, db=db)
        # Eleventh round: held for a calendar the specialist can't change safely, and he's been told so: this
        # one is passed back at once, ready to copy, rather than left to wait.
        told = card_gate(self.ledger).get("cannot_told") or {}
        for provider in providers:
            if told.get(provider) and self.cannot_protect(provider):
                lines = self._pass_back_lines(provider, db, [pid])
                if lines:
                    self._say(db, self.chat_id, job_id,
                              f"<b>Waiting for {provider_name(provider)}</b>, which Harness can't change safely "
                              "for now (the earlier message says why, with Open without protection). Ready to copy "
                              "into the calendar app:\n" + "\n".join(lines))
        # Tenth round: one held on its own day was told so at hold time (its card and the calendar's message
        # say what happens when the day passes), so no second reminder that same day.
        row = db.execute("SELECT params_json FROM proposals WHERE id=?", (pid,)).fetchone()
        try:
            changes = json.loads(row[0])["changes"] if row else []
        except (ValueError, KeyError, TypeError):
            changes = []
        if any(_first_day(c) == self._today() for c in changes):
            self.ledger.set_meta(f"{HELD_DAY_TOLD}{pid}", iso(self.ledger.now()), db)

    def release_held(self) -> int:
        """Each change held for the check after installing whose calendars are all open now comes back on a
        fresh card, read anew, through the normal stale and version checks (eighth round). One whose card
        was replaced meanwhile (a correction) is dropped. Ninth round: the fresh card says how long it was
        held and quotes his message as every card does; one whose day has passed is dropped with a receipt
        instead of offered again; and when more than RELEASE_SUMMARY come back together, one message
        saying so comes first. How many came back."""
        rows = self.ledger.db.execute("SELECT key, value FROM meta WHERE key LIKE ?", (f"{HELD}%",)).fetchall()
        if not rows:
            return 0
        closed = closed_providers(self.ledger)
        from . import approvals
        due = []
        for key, value in rows:
            try:
                held = json.loads(value)
            except ValueError:
                held = {}
            pid = key[len(HELD):]
            row = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
            if any(p in closed for p in held.get("providers") or []) or self._removal_held(row):
                continue
            due.append((key, pid, held, row))
        due.sort(key=lambda d: d[2].get("at") or "")
        today = self._today()
        offer, passed = [], []
        for key, pid, held, p in due:
            try:
                changes = json.loads(p["params_json"])["changes"] if p is not None else []
            except (ValueError, KeyError, TypeError):
                changes = []
            # Tenth round: only adds whose day has passed are dropped; a move or removal of a past event is
            # offered again (read anew, its card says what it finds), never dropped unseen.
            if p is not None and p["state"] == "proposed" and changes \
                    and all(c.get("op") in ("add", "add_series") and _day_passed(c, today) for c in changes):
                passed.append((key, pid, held, p, changes))
            else:
                offer.append((key, pid, held, p, changes))
        for key, pid, held, p, changes in passed:
            with self.ledger.tx() as db:
                db.execute("DELETE FROM meta WHERE key=?", (key,))
                if not approvals.supersede(self.ledger, pid, db=db, outcome="day_passed"):
                    continue
                job = db.execute("SELECT state FROM jobs WHERE id=?", (p["job_id"],)).fetchone()
                if job is not None and job["state"] == "proposed":
                    self.ledger.transition(p["job_id"], "expired", db=db, receipt=json.dumps(
                        {"effect": effects.CALENDAR_CHANGE, "outcome": "day_passed"}))
                self.ledger.event("calendar_change_held_dropped", {"proposal": pid}, db=db)
                lines = [render.change_line(c, self.tz, self.ledger.now()) for c in changes]
                self._say(db, self.chat_id, p["job_id"],
                          f"<b>Dropped.</b> This waited {self._held_for(held)} for the check after installing, and "
                          f"its day has passed, so it isn't offered again and nothing was changed:\n"
                          + "\n".join(render.escape(x) for x in lines)
                          + "\nAsk Cain again if you still want something like it.")
            log.info("calendar change job %s: held past its day, dropped with a receipt", render.short(p["job_id"]))
        live = [d for d in offer if d[3] is not None and d[3]["state"] == "proposed" and self.recard is not None]
        if len(live) > RELEASE_SUMMARY:
            names = " and ".join(provider_name(x) for x in SMOKE_PROVIDERS if x not in closed)
            with self.ledger.tx() as db:
                self._say(db, self.chat_id, None,
                          f"<b>{len(live)} changes waited for the check after installing</b>, which is done on "
                          f"{names or 'your calendars'}. Each comes back now on a fresh card of its own, read again "
                          "just now, for your tap. Nothing has changed yet.")
        n = 0
        for key, pid, held, p, changes in offer:
            with self.ledger.tx() as db:
                db.execute("DELETE FROM meta WHERE key=?", (key,))
                took = p is not None and p["state"] == "proposed" and self.recard is not None \
                    and approvals.supersede(self.ledger, pid, db=db, outcome="replaced")
            if not took:
                continue
            names = " and ".join(provider_name(x) for x in held.get("providers") or [])
            log.info("calendar change job %s: no longer held for the check after installing", render.short(p["job_id"]))
            try:
                self.recard(p, changes, f"it waited {self._held_for(held)} for the check after installing, which is "
                                        f"done on {names or 'that calendar'}, so here it is, read again just now",
                            False)
                n += 1
            except (Refuse, ValueError, KeyError, TypeError) as e:
                log.warning("offering a held change again failed: %s", type(e).__name__)
        return n

    # -- held requests are told at hold time (tenth round) ---------------------------------------
    def _held_why(self, provider: str) -> tuple[str, str]:
        """Why a calendar's changes are held, and what unblocks it, in his words."""
        gate = card_gate(self.ledger)
        name = provider_name(provider)
        rec = (gate.get("conformance") or {}).get(provider) or {}
        if provider not in closed_providers(self.ledger) and removals_unprotected(self.ledger, provider):
            return (f"during the check after installing, {name} took a removal sent with an out of date version",
                    f"nothing on the specialist's side for removals: they need making in the calendar app, or a "
                    f"later check passing for {name}")
        if rec.get("fresh_failed"):
            return (f"{name} turned down the check's own edit sent with the version it had just given",
                    "Open without protection or Test again, on the message about it")
        if rec.get("result") == "ignored":
            return (f"{name} takes a change sent with an out of date version, so Harness can't change it safely",
                    "Open without protection, on the message about it; or make the change by hand there")
        if rec.get("result") == "partial":
            return (f"during the check after installing, {name} took a write sent with an out of date version",
                    "your Open cards without the check, from the message about it, which is kept in the log")
        if (gate.get("blocked") or {}).get(provider):
            return (f"{name} turned down the safety check during the check after installing, on an unchanged event",
                    "your Open cards without the check, from the message about it, or a later check passing")
        return ("the check after installing hasn't finished there yet",
                f"Cain finishing the check after installing for {name}, usually within the hour; each held request then comes back "
                "on a fresh card for your tap")

    def tell_held(self, providers: list[str], db) -> None:
        """At hold time: one message per calendar (tenth round), the first time a request is held there
        after this install, saying changes there are held, why, and what unblocks it. Further requests held
        there are counted in the daily reminder, not told one by one."""
        gate = card_gate(self.ledger)
        if not gate:
            return
        told = gate.setdefault("held_told", {})
        cannot = gate.get("cannot_told") or {}
        for p in providers:                 # eleventh round: passed back instead (note_held)
            if cannot.get(p) and self.cannot_protect(p):
                told.setdefault(p, iso(self.ledger.now()))
        new = [p for p in dict.fromkeys(providers) if not told.get(p)]
        if not new:
            return
        now = iso(self.ledger.now())
        for provider in new:
            told[provider] = now
            why, unblock = self._held_why(provider)
            name = provider_name(provider)
            self._say(db, self.chat_id, None,
                      f"<b>Calendar changes on {name} are held for now.</b> Harness was updated, and {why}, so "
                      f"requests for {name} wait with no Approve. Nothing has changed. What lets them through: "
                      f"{unblock}. While any wait you get one reminder a day, and one before a held request's "
                      "day comes; an add whose day passes is dropped with a receipt, and a move or removal comes "
                      "back on a card either way.")
        gate["held_reminded"] = self._today().isoformat()
        self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
        self.ledger.event("calendar_change_held_told", {"calendars": new}, db=db)

    def _held_rows(self) -> list[tuple[str, dict, Any]]:
        out = []
        for key, value in self.ledger.db.execute("SELECT key, value FROM meta WHERE key LIKE ?", (f"{HELD}%",)):
            try:
                held = json.loads(value)
            except ValueError:
                held = {}
            pid = key[len(HELD):]
            p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
            if p is not None and p["state"] == "proposed":
                out.append((pid, held, p))
        return out

    def remind_held(self) -> None:
        """Tenth round: while any request is held, one reminder a day with the count per calendar; and a
        held request whose day is today gets a reminder that day, not a silent drop later."""
        rows = self._held_rows()
        gate = card_gate(self.ledger)
        if not rows or not gate:
            return
        today = self._today()
        lines = []
        due_today = []
        for pid, held, p in rows:
            if self.ledger.get_meta(f"{HELD_DAY_TOLD}{pid}") is not None:
                continue
            try:
                changes = json.loads(p["params_json"])["changes"]
            except (ValueError, KeyError, TypeError):
                continue
            if any(_first_day(c) == today for c in changes):
                due_today.append((pid, p, changes))
        daily = gate.get("held_reminded") != today.isoformat()
        if not daily and not due_today:
            return
        with self.ledger.tx() as db:
            if daily:
                counts: dict = {}
                for _, held, _p in rows:
                    for prov in held.get("providers") or []:
                        counts[prov] = counts.get(prov, 0) + 1
                parts = [f"{n} for {provider_name(x)}" for x, n in counts.items()]
                why = "; ".join(f"{provider_name(x)}: {self._held_why(x)[0]}, and what lets them through is "
                                f"{self._held_why(x)[1]}" for x in counts)
                lines.append(f"<b>{len(rows)} calendar request{'s' * (len(rows) != 1)} still held</b> "
                             f"({', '.join(parts)}). {why}. Nothing has changed.")
                gate["held_reminded"] = today.isoformat()
                self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
            if due_today:
                lines.append("<b>Held, and for today:</b>")
                for pid, p, changes in due_today:
                    self.ledger.set_meta(f"{HELD_DAY_TOLD}{pid}", iso(self.ledger.now()), db)
                    what = "; ".join(render.change_line(c, self.tz, self.ledger.now()) for c in changes)
                    asked = self._request_words(p)
                    lines.append(f"• {render.escape(what)}" + (f" ({asked})" if asked else ""))
                lines.append("An add still held when its day has passed is dropped with a receipt; ask Cain to "
                             "make it some other way if it can't wait.")
            self._say(db, self.chat_id, None, "\n".join(lines))
            self.ledger.event("calendar_change_held_reminded", {"held": len(rows), "today": len(due_today)}, db=db)

    def _removal_held(self, p) -> bool:
        """Tenth round: a held removal on a calendar whose stale removals weren't refused stays held."""
        if p is None:
            return False
        try:
            changes = json.loads(p["params_json"])["changes"]
        except (ValueError, KeyError, TypeError):
            return False
        return any(c.get("op") == "remove" and removals_unprotected(self.ledger, c.get("calendar", ""))
                   for c in changes)

    def _held_for(self, held: dict) -> str:
        """How long a held change waited, in words (ninth round)."""
        try:
            secs = (self.ledger.now() - datetime.fromisoformat(held["at"])).total_seconds()
        except (KeyError, ValueError, TypeError):
            return "a while"
        if secs < 3600:
            m = max(1, int(secs // 60))
            return f"{m} minute{'s' * (m != 1)}"
        if secs < 48 * 3600:
            h = int(secs // 3600)
            return f"{h} hour{'s' * (h != 1)}"
        d = int(secs // 86400)
        return f"{d} days"

    def _run_rows(self, run: dict) -> list:
        return [r for r in self.ledger.db.execute(
            "SELECT c.*, p.created_at AS asked FROM calendar_changes c JOIN proposals p ON p.id=c.proposal_id"
            " WHERE c.created_at>=? ORDER BY c.created_at", (run.get("at") or "",)).fetchall()
            if _plan(r).get("smoke") == run.get("id")]

    def smoke_evidence(self, run_id: str) -> tuple[list[dict], list[str], int | None]:
        """The smoke run's checklist, every item built from what this ledger recorded of the run's
        changes (sixth round): ([{"item", "words"}], [what has no evidence], the listing lag seen). An
        item without matching evidence is a fail; nothing anyone says about the run counts. Seventh
        round: a run that isn't live is refused whole (run_problem), and the listing lag needs at least
        LAG_SAMPLES samples on each calendar, each within LAG_MAX_S."""
        run = smoke_run(self.ledger)
        problem = self.run_problem(run, run_id) if run_id else "no smoke run named"
        if problem:
            return [], [problem], None
        rows = self._run_rows(run)
        found: dict[str, dict] = {}
        lags: dict[str, list[float]] = {p: [] for p in SMOKE_PROVIDERS}
        series: dict[tuple, dict] = {}
        for r in rows:
            plan = _plan(r)
            read_ok = r["state"] in ("done", "landed_late")
            providers = set()
            for part in plan.get("parts", []):
                for rec in part.get("steps", []):
                    provider, op = _STEP_FN.get((rec.get("spec") or {}).get("fn", ""), ("", ""))
                    entry = rec.get("entry") or {}
                    tail = _tail(entry.get("id") or entry.get("href") or "")
                    if not provider:
                        continue
                    if read_ok and rec.get("status") == "landed" and entry:
                        providers.add(provider)
                        found.setdefault(f"{provider}.{op}", {
                            "id": tail, "asked": r["asked"], "back": rec.get("back") or r["updated_at"],
                            "entry": {k: entry.get(k) for k in ("cal", "id", "href", "how") if entry.get(k)},
                            "op": op})
                        if rec.get("abandoned"):
                            found.setdefault(SMOKE_LATE, {"provider": provider, "id": tail,
                                                          "back": rec.get("back") or r["updated_at"]})
                    if r["state"] == "stale" and rec.get("kind") == "stale" and rec.get("unsent"):
                        # Eighth round: the read just before the write found the event changed since its
                        # card, and nothing was sent.
                        found.setdefault(f"{provider}.stale", {"id": tail or _tail(_bound_id(part)),
                                                               "sent": rec.get("caught") or r["updated_at"]})
                if read_ok and part.get("change", {}).get("op") in ("move", "remove"):
                    for b in part.get("bound") or []:
                        if b.get("recurrence"):
                            series.setdefault((b["calendar"], b["series"]), {}).setdefault(
                                b["instance"], {"title": b.get("title", ""), "start": b.get("start", ""),
                                                "row": r["proposal_id"]})
            if r["undo_state"] == "undone" and plan.get("undone_at"):     # read back as it was (_undo)
                for e in plan.get("undone_entries", []):
                    if e.get("cal") in SMOKE_PROVIDERS:
                        found.setdefault(f"{e['cal']}.undo", {"id": _tail(e.get("id") or e.get("href") or ""),
                                                             "back": plan["undone_at"]})
            if read_ok and plan.get("listed_at"):
                # From the write read back by its id to the days, read as he'd see them, showing it.
                back = [rec.get("back") for part in plan.get("parts", []) for rec in part.get("steps", [])
                        if rec.get("back")]
                if back:
                    lag = (datetime.fromisoformat(plan["listed_at"]) - datetime.fromisoformat(max(back))).total_seconds()
                    for provider in providers:
                        lags[provider].append(lag)
        for provider, conf in (run.get("conformance") or {}).items():
            # Ninth round: the run's own test event, edited with a version it made stale itself, refused.
            if provider in SMOKE_PROVIDERS and (conf or {}).get("result") == "enforced":
                found.setdefault(f"{provider}.{CONFORMANCE}", {"id": _tail(conf.get("id") or ""), "at": conf["at"]})
        for (cal, _), days in series.items():
            if len({d["row"] for d in days.values()}) >= 2:
                two = sorted(days.values(), key=lambda d: d["start"])[:2]
                found.setdefault(SMOKE_SERIES, {"provider": cal, "title": two[0]["title"],
                                                "days": [d["start"] for d in two]})
        lag_problem = []
        for provider, got in lags.items():
            name = "Gmail" if provider == "gmail" else "Family"
            if len(got) < LAG_SAMPLES:
                lag_problem.append(f"{len(got)} sample{'s' * (len(got) != 1)} on {name}, {LAG_SAMPLES} needed")
            elif any(x < 0 or x > LAG_MAX_S for x in got):
                worst = int(round(max(got, key=lambda x: abs(x))))
                lag_problem.append(f"{worst} seconds on {name} is outside 0 to {LAG_MAX_S}")
        everything = [x for got in lags.values() for x in got]
        lag = int(round(max(everything))) if everything else None
        if not lag_problem:
            found[SMOKE_LAG] = {"seconds": max(0, lag or 0),
                                "samples": {p: [int(round(max(0, x))) for x in got] for p, got in lags.items()}}
        items, missing = [], []
        for item in SMOKE_ITEMS:
            if item in found:
                items.append({"item": item, "words": self._evidence_words(item, found[item]), **found[item]})
            elif item.endswith("." + CONFORMANCE):
                conf = (run.get("conformance") or {}).get(item.split(".")[0]) or {}
                missing.append(item + (": the calendar accepted a write sent with an out of date version, so it "
                                       "doesn't protect against concurrent edits" if conf.get("result") == "ignored"
                                       else ": run keeper.sh fastpath smoke-step <run id> " + CONFORMANCE + "-"
                                       + item.split(".")[0]))
            else:
                missing.append(item if item != SMOKE_LAG else f"{SMOKE_LAG}: " + "; ".join(lag_problem))
        # Twelfth round: the no-card paths stay off until the run recorded each calendar's version strength and,
        # on Family, how it answers a PUT with no If-Match.
        for provider in SMOKE_PROVIDERS:
            conf = (run.get("conformance") or {}).get(provider) or {}
            if not conf.get("etag_strength"):
                missing.append(f"{provider}.etag_strength: run keeper.sh fastpath smoke-step <run id> "
                               f"{CONFORMANCE}-{provider}")
            if provider == "family" and conf.get("unguarded_put") not in ("taken", "refused"):
                missing.append("family.unguarded_put: a PUT with no If-Match on the run's own test event, taken or "
                               f"refused (run keeper.sh fastpath smoke-step <run id> {CONFORMANCE}-family)")
        # Eighth round: each calendar's gate after an install opens only on a fenced edit and a series-day
        # edit read back there (or his logged override); until then the run isn't whole.
        gate = card_gate(self.ledger)
        for provider in closed_providers(self.ledger):
            seen = (gate.get("seen") or {}).get(provider) or {}
            lacks = [w for k, w in (("fenced", "a move or removal sent with If-Match on an event that was there"),
                                    ("series", "an edit of one day of a series")) if not seen.get(k)]
            if conformance_of(self.ledger, provider) != "enforced":
                lacks.append("the conformance item (a stale write to the run's own test event, refused)")
            missing.append(f"{provider}.gate: " + ("the calendar turned down the safety check while the event was unchanged"
                                                   if (gate.get("blocked") or {}).get(provider) else
                                                   " and ".join(lacks) + ", read back"))
        return items, missing, (min(max(lag, 0), LAG_MAX_S) if lag is not None else None)

    def _live_words(self, ev: dict) -> str:
        """Seventh round: an evidenced event read again from its calendar now, beside the ledger's entry."""
        entry = ev.get("entry") or {}
        try:
            if entry.get("cal") == "gmail" and entry.get("id"):
                kind, now = self.google.look(self._gmail_address(), entry["id"])
                if kind == "gone" or (kind == "ok" and (now or {}).get("status") == "cancelled"):
                    return "now: not on the calendar"
                if kind == "ok" and now:
                    start, end = self._gmail_when(now.get("start")), self._gmail_when(now.get("end"))
                    return (f"now: “{_safe(now.get('summary', ''))}” at {self._at_words(start, end)}"
                            if start is not None and end is not None else "now: on the calendar")
            elif entry.get("cal") == "family" and entry.get("href"):
                out, body = self.client.fetch(entry["href"])
                if out.kind == "gone":
                    return "now: not on the calendar"
                if out.kind == "ok":
                    _, events = ical.parse_calendar(body)
                    title = events[0].first("SUMMARY") if events else None
                    return f"now: “{_safe(ical.unescape(title.value))}” on the calendar" if title else \
                        "now: on the calendar"
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            pass
        return "now: couldn't be read"

    def _local(self, stamp: str) -> str:
        try:
            t = datetime.fromisoformat(stamp).astimezone(ZoneInfo(self.tz))
        except (ValueError, TypeError):
            return "an unknown time"
        return f"{render.clock_words(t, suffix=True)} {t:%a %b} {t.day}"

    def _evidence_words(self, item: str, ev: dict) -> str:
        cal = {"gmail": "Gmail", "family": "Family"}
        provider, _, step = item.partition(".")
        idw = f"id ending {ev['id']}" if ev.get("id") else "its id"
        if step in ("add", "move", "remove"):
            what = {"add": "An add", "move": "A move", "remove": "A removal"}[step]
            return (f"{cal[provider]}: {what}, {idw}, asked {self._local(ev['asked'])}, read back as asked "
                    f"{self._local(ev['back'])}.")
        if step == "undo":
            return f"{cal[provider]}: An Undo, {idw}, read back as it was {self._local(ev['back'])}."
        if step == CONFORMANCE:
            return (f"{cal[provider]}: The check's own test event, {idw}, edited with a version made out of date by "
                    f"its own edit at {self._local(ev['at'])}: the calendar refused it, so it guards against edits "
                    "made at the same time.")
        if step == "stale":
            return (f"{cal[provider]}: A card for an event that changed since it, {idw}, at {self._local(ev['sent'])}: "
                    "the read just before writing found the change, so nothing was sent and it was not applied.")
        if item == SMOKE_SERIES:
            days = ", ".join(self._local(d).split(" ", 2)[-1] for d in ev["days"])
            return (f"Two days of one series on {cal.get(ev['provider'], ev['provider'])}, "
                    f"“{_safe(ev['title'])}”, {days}: both read back as asked.")
        if item == SMOKE_LATE:
            return (f"A write whose answer came late, {cal.get(ev['provider'], '')} {idw}: read back as landed "
                    f"{self._local(ev['back'])}.")
        n = ev["seconds"]
        per = "; ".join(f"{cal[p]}: " + ", ".join(f"{x}s" for x in got)
                        for p, got in (ev.get("samples") or {}).items() if got)
        return (f"New events showed in the calendar's listing within {n} second{'s' * (n != 1)}"
                + (f" ({per})" if per else "") + ".")

    # -- the run's test events, and taking them off ----------------------------------------
    def smoke_leftovers(self, run_id: str) -> list[dict]:
        """A smoke run's test events still on a calendar (seventh and ninth rounds): only the events the run
        recorded as created by itself, by id (created_by: its steps' adds and its conformance events), each
        read by its id now, there and still carrying the run's tag. Nothing else is ever listed, whatever
        its title. [{"cal", "id" | "href", "title"}]."""
        run = smoke_run(self.ledger)
        if run.get("id") != run_id:
            return []
        out = []
        for entry in self.created_by(run_id):
            left = self._leftover(entry, run_id)
            if left and left not in out:
                out.append(left)
        return out

    def _leftover(self, entry: dict, run_id: str) -> dict | None:
        got = self._leftover_by_id(entry, run_id)
        if got is None and entry.get("nonce"):
            got = self._leftover_by_nonce(entry, run_id)
        return got

    def _leftover_by_nonce(self, entry: dict, run_id: str) -> dict | None:
        """Tenth round: an event of the run not found by the id it was given (a provider that changed it, a
        create whose answer was lost) is looked for on its day by its exact nonce, with the run's tag too.
        Never by the tag alone: another step's event, or one without the nonce, is never listed."""
        try:
            day = date.fromisoformat(str(entry.get("day") or "")[:10])
        except ValueError:
            return None
        try:
            last = date.fromisoformat(str(entry.get("until") or "")[:10])
        except ValueError:
            last = day
        nonce = str(entry["nonce"])
        # Eleventh round: from the day before the recorded day to the day after (a step near midnight in his
        # zone lands on either side of it), and for a series the whole of it, to the day after its last.
        days = [day - timedelta(days=1), max(day, last) + timedelta(days=1)]
        lo, hi = self._bounds(days)
        try:
            if entry.get("cal") == "gmail":
                for ev in self.google.events_between(self._gmail_address(), lo, hi, fresh=True) or []:
                    tags = (ev.get("extendedProperties") or {}).get("private") or {}
                    if ev.get("status") != "cancelled" and tags.get(SMOKE_PROP) == run_id \
                            and tags.get(SMOKE_NONCE_PROP) == nonce and ev.get("id"):
                        ident = ev.get("recurringEventId") or ev["id"]     # a series: the series, not one day
                        return {"cal": "gmail", "id": ident, "title": ev.get("summary", ""), "nonce": nonce}
            elif entry.get("cal") == "family":
                found, _ = self._read("family", days, fresh=True)
                for f in found:
                    href = getattr(f.raw, "href", "")
                    if not href:
                        continue
                    out, body = self.client.fetch(href)
                    flat = (body or "").replace("\r\n", "\n") + "\n"
                    if out.kind == "ok" and f"X-HARNESS-SMOKE:{run_id}\n" in flat \
                            and f"X-HARNESS-SMOKE-NONCE:{nonce}\n" in flat:
                        return {"cal": "family", "href": href, "title": f.title, "nonce": nonce}
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            return None
        return None

    def _leftover_by_id(self, entry: dict, run_id: str) -> dict | None:
        try:
            if entry.get("cal") == "gmail" and entry.get("id"):
                kind, now = self.google.look(self._gmail_address(), entry["id"])
                if kind != "ok" or not now or now.get("status") == "cancelled":
                    return None
                tag = ((now.get("extendedProperties") or {}).get("private") or {}).get(SMOKE_PROP)
                if tag != run_id:
                    return None
                return {"cal": "gmail", "id": entry["id"], "title": now.get("summary", "")}
            if entry.get("cal") == "family" and entry.get("href"):
                out, body = self.client.fetch(entry["href"])
                if out.kind != "ok" or f"X-HARNESS-SMOKE:{run_id}" not in (body or "").replace("\r\n", "\n"):
                    return None
                _, events = ical.parse_calendar(body)
                title = events[0].first("SUMMARY") if events else None
                return {"cal": "family", "href": entry["href"],
                        "title": ical.unescape(title.value) if title else ""}
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            return None
        return None

    def post_leftovers(self, run_id: str, why: str) -> int:
        """One message listing the run's test events still on a calendar, with one Take them off button
        (seventh round: at Turn on's card, at a refusal and when the run runs out). How many."""
        left = self.smoke_leftovers(run_id)
        if not left:
            return 0
        with self.ledger.tx() as db:
            self.ledger.set_meta(LEFTOVERS + run_id, json.dumps(left), db)
            nonce = choices.mint(self.ledger, kind="calendar_change_smoke_clear", target=run_id,
                                 chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
            lines = [f"<b>Test events from the check after installing are still on your calendars</b> ({why}):"]
            lines += [f"• {'Gmail' if x['cal'] == 'gmail' else 'Family'}: “{_safe(x['title'])}”"
                      for x in left]
            lines.append("Take them off removes each one, only if it's still as the test left it.")
            self._say(db, self.chat_id, None, "\n".join(lines),
                      buttons=[[("Take them off", choices.callback_data(nonce))]],
                      binds=[{"type": "choice", "nonce": nonce}])
        return len(left)

    def clear_leftovers(self, run_id: str) -> str:
        """His Take them off: each test event read again and removed with its version as If-Match, so one
        changed since is left alone."""
        try:
            left = json.loads(self.ledger.get_meta(LEFTOVERS + run_id) or "[]")
        except ValueError:
            left = []
        gone, kept = 0, 0
        for x in left:
            try:
                if x.get("cal") == "gmail":
                    address = self._gmail_address()
                    kind, now = self.google.look(address, x["id"])
                    tag = ((now or {}).get("extendedProperties") or {}).get("private", {}).get(SMOKE_PROP)
                    if kind != "ok" or tag != run_id:
                        kept += kind == "ok"
                        continue
                    out = self.google.drop(address, x["id"], now.get("etag"))
                else:
                    got, body = self.client.fetch(x["href"])
                    if got.kind != "ok" or f"X-HARNESS-SMOKE:{run_id}" not in (body or "").replace("\r\n", "\n"):
                        kept += got.kind == "ok"
                        continue
                    out = self.client.remove_at(x["href"], got.etag)
            except (Refuse, ValueError, KeyError, TypeError, AttributeError):
                kept += 1
                continue
            if getattr(out, "kind", "") == "ok":
                gone += 1
            else:
                kept += 1
        with self.ledger.tx() as db:
            db.execute("DELETE FROM meta WHERE key=?", (LEFTOVERS + run_id,))
            self.ledger.event("calendar_smoke_cleared", {"run": run_id, "gone": gone, "kept": kept}, db=db)
        if not gone and not kept:
            return "Nothing of the test was left to take off."
        return (f"Took off {gone} test event{'s' * (gone != 1)}." if gone else "") + (
            f" Left {kept} that changed since the test or couldn't be read." if kept else "")

    def expire_runs(self) -> None:
        """A smoke run that ran out ends (seventh round): nothing more is tagged under it, its Turn on card
        comes off, and its test events still on a calendar are listed with Take them off."""
        run = smoke_run(self.ledger)
        if not run.get("id") or run.get("closed"):
            return
        try:
            out = self.ledger.now() >= datetime.fromisoformat(run.get("expires") or run["at"])
        except (ValueError, TypeError, KeyError):
            out = True
        if not out and not self.run_problem(run):
            return
        with self.ledger.tx() as db:
            self._close_run(db, run, "expired" if out else "install")
            self.retire_turn_on(db)
        log.info("smoke run ended: %s", "it ran out" if out else "it doesn't belong to this install")
        self.post_leftovers(run["id"], "the test ran out" if out else "Harness updated since the test")

    def _no_card_paths(self) -> list[str]:
        """Every path Turn on lets go through without a card, the stored bake-in opt-in by calendar and
        date included."""
        from .family_add import LOOSENED
        out = ["Your own newest message, under 2 minutes old, with one clear change.",
               "A date from your mail you send to Family from its card."]
        if self.ledger.get_meta(LOOSENED):
            when = self.ledger.db.execute("SELECT at FROM events WHERE kind='family_add_loosened' ORDER BY id DESC"
                                          " LIMIT 1").fetchone()
            day = ""
            if when is not None:
                t = datetime.fromisoformat(when[0]).astimezone(ZoneInfo(self.tz))
                day = f" on {t:%a %b} {t.day}"
            out.append(f"Family calendar adds: you said to stop checking each one{day}, so they go too.")
        else:
            out.append("Family calendar adds: none yet, since you haven't said to stop checking each one.")
        return out

    def offer_fast_path(self, run_id: str) -> list[str]:
        """keeper.sh fastpath on <run id>: the run's checklist, judged from this ledger. Anything with no
        evidence is returned and nothing is offered (seventh round: its test events still on a calendar
        are listed with Take them off). A full one goes to him on one card: each item's evidence in
        plain words beside the event as its calendar reads it now, every path Turn on enables, with
        Turn on and Keep cards. The listing lag it saw (capped) sizes the long window's read (LATE_READ)
        and is fed into the duplicate and no-card checks (LISTING_LAG). Nothing turns on here."""
        items, missing, lag = self.smoke_evidence(run_id)
        if missing:
            if smoke_run(self.ledger).get("id") == run_id:
                self.post_leftovers(run_id, "the check after installing was refused")
            return missing
        offer = {"id": canonical_hash({"run": run_id, "items": items})[:16], "run": run_id, "items": items,
                 "lag": lag, "at": iso(self.ledger.now())}
        shown = [render.escape(i["words"]) + (f" ({render.escape(self._live_words(i))})" if i.get("entry") else "")
                 for i in items]
        text = ("<b>The check after installing passed.</b> What this specialist's own record shows for it, each "
                "event beside how its calendar reads it now:\n"
                + "\n".join(f"• {x}" for x in shown)
                + "\nTurn on lets these go through without a card, each still with its receipt and Undo:\n"
                + "\n".join(f"• {render.escape(x)}" for x in self._no_card_paths())
                + "\nKeep cards leaves every change on a card. After Turn on, Turn off here puts them back on cards.")
        with self.ledger.tx() as db:
            self.retire_turn_on(db)                  # one Turn on card at a time
            self.ledger.set_meta(LATE_READ, str(min(3600, max(LATE_READ_S, 5 * (lag or 0)))), db)
            self.ledger.set_meta(LISTING_LAG, str(lag or 0), db)
            self.ledger.set_meta(FAST_OFFER, json.dumps(offer), db)
            on = choices.mint(self.ledger, kind="calendar_change_fast_on", target=offer["id"],
                              chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
            keep = choices.mint(self.ledger, kind="calendar_change_fast_keep", target=offer["id"],
                                chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
            self.ledger.event("calendar_fast_path_offered", {"run": run_id, "lag": lag}, db=db)
            self._say(db, self.chat_id, None, render.fit(text),
                      buttons=[[("Turn on", choices.callback_data(on)), ("Keep cards", choices.callback_data(keep))]],
                      binds=[{"type": "choice", "nonce": on}, {"type": "choice", "nonce": keep}])
        self.post_leftovers(run_id, "the check after installing passed")
        return []

    def fast_path_tapped(self, on: bool, target: str) -> str:
        """His tap on the smoke run's card: only Turn on, on the card for the run still current and live,
        with its evidence still in the ledger, sets the flag, with the run, who tapped and when; the run
        is then used (one Turn on per run id) and stops tagging; then a Turn off button sits on that
        card."""
        try:
            offer = json.loads(self.ledger.get_meta(FAST_OFFER) or "{}")
        except ValueError:
            offer = {}
        if not offer or offer.get("id") != target:
            return "That card is for an older check, so nothing changed. Every change still comes on a card."
        if not on:
            with self.ledger.tx() as db:
                self.ledger.event("calendar_fast_path_kept", {"by": str(self.chat_id), "at": iso(self.ledger.now())},
                                  db=db)
            return "Kept: every calendar change still comes on a card for your tap."
        _, missing, _ = self.smoke_evidence(offer.get("run", ""))
        if missing:
            with self.ledger.tx() as db:
                self.retire_turn_on(db)
            return "The record for that check changed since its card, so nothing changed. Every change still comes on a card."
        mid = self.ledger.db.execute("SELECT message_id FROM choices WHERE kind='calendar_change_fast_on' AND target=?",
                                     (target,)).fetchone()
        with self.ledger.tx() as db:
            set_fast_path(self.ledger, True, {"run": offer["run"], "items": [i["item"] for i in offer["items"]],
                                              "lag": offer.get("lag")}, by=str(self.chat_id), db=db)
            db.execute("DELETE FROM meta WHERE key=?", (FAST_OFFER,))
            run = smoke_run(self.ledger)
            if run.get("id") == offer["run"]:
                self._close_run(db, run, "turned_on", used=True)
            if mid is not None and mid[0]:
                off = choices.mint(self.ledger, kind="calendar_change_fast_off", target=offer["run"],
                                   chat_id=self.chat_id, ttl_s=TURN_OFF_TTL_S, db=db)
                db.execute("UPDATE choices SET message_id=? WHERE nonce=?", (mid[0], off))
                self.ledger.enqueue(chat_id=self.chat_id, kind="rebutton", text=str(mid[0]),
                                    buttons=[[("Turn off", choices.callback_data(off))]], db=db)
        return ("Turned on: your own fresh, clear words, a mail date you tap Add to Family on, and Family adds "
                "after the stop-checking tap now go through without a card, each with its receipt and Undo. "
                "Turn off on that card puts every change back on a card.")

    def turn_off(self, by: str) -> None:
        """Off at once (his Turn off, or Cain's keeper.sh fastpath off), seventh round: the run behind it
        is over, every Turn on card still open comes off, and turning on again needs a new smoke run."""
        with self.ledger.tx() as db:
            set_fast_path(self.ledger, False, fast_path(self.ledger).get("smoke", ""), by=by, db=db)
            run = smoke_run(self.ledger)
            if run.get("id") and not run.get("closed"):
                self._close_run(db, run, "turned_off", used=True)
            self.retire_turn_on(db)

    def fast_path_off_tapped(self) -> str:
        """His Turn off on the smoke run's card: off at once. A change approved for the no-card path
        and not yet written comes back as his card (_fast_path_holds, at the write)."""
        self.turn_off(str(self.chat_id))
        return ("Turned off: every calendar change comes on a card for your tap again, including any approved "
                "a moment ago and not written yet. Turning it on again takes a new check after installing.")

    def fast_path_ok(self) -> bool:
        """Whether a change may go through with no card at all (FAST_PATH)."""
        on = fast_path_on(self.ledger)
        if not on:
            log.info("no-card path is off until the smoke test is recorded: a card instead")
        return on

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
        from . import migrate
        if migrate.waiting(self.ledger):
            return                   # tenth round: nothing runs until the records are moved to this build
        self._expire_offers()
        self.expire_runs()
        self._fail_orphans()
        self._drain_late()
        if not paused:
            self._resume_paused()
            self.release_held()
            self.remind_held()
        for p in self._approved():
            self._execute(p, paused)
        if not paused:
            self._settle_pending()
            self._recheck_unverified()
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
            if self.ledger.get_meta(f"{HELD}{p['id']}") is not None:
                continue                             # held for the check after installing: it comes back then
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

    # -- a change being written: its lease ---------------------------------------------------
    def lease_state(self, proposal_id: str) -> str:
        """A change approved and being written counts as being done only while its lease runs
        (0.24.0, third round): "live" for LEASE_S after it was approved or last wrote. Past that the
        calendar is read: "done" when it shows every part as asked, "not_done" otherwise, and a
        change found not done stops here (nothing of it is written again on its own; what landed
        keeps its record), so it can be offered again."""
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone()
        if p is None:
            return "not_done"
        row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (proposal_id,)).fetchone()
        stamps = [p["created_at"]] + [r[0] for r in self.ledger.db.execute(
            "SELECT consumed_at FROM approvals WHERE proposal_id=? AND consumed_at IS NOT NULL", (proposal_id,))]
        if row is not None:
            stamps.append(row["updated_at"])
        since = max(datetime.fromisoformat(x) for x in stamps if x)
        if (self.ledger.now() - since).total_seconds() < LEASE_S:
            return "live"
        plan = _plan(row) if row is not None else {}
        # Never read as run out while a write of it could still be on its way (0.24.0, fifth round):
        # not before its last write's deadline has passed (the write's own thread ends by then).
        sent = plan.get("read_at")
        if sent and (self.ledger.now() - datetime.fromisoformat(sent)).total_seconds() < self.write_deadline_s:
            return "live"
        parts = plan.get("parts") or []
        # Never lapsed on one read (0.24.0, fourth round): two reads, a few seconds apart, must both
        # answer and both find it not done. One that can't be read leaves it in progress ("unsure").
        verdicts = []
        for attempt in range(2):
            if attempt:
                self.sleep(READ_BACK_PAUSE_S)
            verdict = self._reads_done(parts) if row is not None else "not_done"
            verdicts.append(verdict)
            if verdict == "done":
                break
        state = "done" if verdicts[-1] == "done" else "not_done" if verdicts == ["not_done", "not_done"] \
            else "unsure"
        log.info("calendar change %s: its lease ran out; reads say %s", render.short(proposal_id), ", ".join(verdicts))
        if state == "not_done" and p["state"] in ("approved", "auto_approved", "executing"):
            with self.ledger.tx() as db:
                db.execute("UPDATE proposals SET state='failed' WHERE id=? AND state IN"
                           " ('approved','auto_approved','executing')", (proposal_id,))
                if row is not None and plan.get("parts"):
                    # Read again like a change not confirmed (fifth round): 30 seconds, 2 minutes, the long
                    # window, then watched by id; one that shows up is Done after all (_recheck_unverified).
                    self._schedule_reads(plan, list(range(len(plan["parts"]))))
                    plan["lapsed_at"] = iso(self.ledger.now())
                    db.execute("UPDATE calendar_changes SET settle_json=? WHERE proposal_id=?",
                               (json.dumps(plan), proposal_id))
                db.execute("UPDATE calendar_changes SET state='lapsed', updated_at=? WHERE proposal_id=?"
                           " AND state IN ('sending','settling')", (iso(self.ledger.now()), proposal_id))
                # Its fencing token is retired: a write of it that answers from now on is fenced out
                # (_drain_late), and a landed one is recorded, never left beside a second.
                fence = self.ledger.get_meta(f"calendar_change_fence:{proposal_id}") or ""
                self.ledger.set_meta(f"calendar_change_fence:{proposal_id}", f"lapsed:{fence}", db)
                job = db.execute("SELECT state FROM jobs WHERE id=?", (p["job_id"],)).fetchone()
                if job is not None and job["state"] == "approved":
                    self.ledger.transition(p["job_id"], "failed", db=db,
                                           receipt=json.dumps({"reason": "lease_lapsed"}))
        return state

    def _reads_done(self, parts: list[dict]) -> str:
        """One read of a change's parts: "done" when the calendar shows every part as asked, an add
        found by its own fixed id first; "not_done" when a read answered and doesn't; "unread" when
        a calendar couldn't be read."""
        if not parts or not all(part.get("expect") or part.get("already") for part in parts):
            return "not_done"
        unread_any = False
        for part in parts:
            if part.get("already"):
                continue
            left = [e for e in part["expect"] if not (e["kind"] == "there" and self._by_id(e) == "same")]
            if not left:
                continue
            problems, _, unread = self._check_part(Part(part["will"], part["done"], [], name=part.get("name", ""),
                                                        bound=part.get("bound") or [], expect=left))
            if problems:
                return "not_done"
            unread_any = unread_any or bool(unread)
        return "unread" if unread_any else "done"

    # -- the ledger migration (migrate.py): changes the version before left in flight ----------
    def read_in_flight(self, p) -> tuple[str, list[dict], list[dict]]:
        """A change the version before left approved or mid-write, read back from the calendar and
        never written: ("done", the writes a read found landed, its parts) when the calendar shows all
        of it, else ("unverified", what landed, its parts). One never started kept no event id of its
        own (0.24.0, fifth round): it's done only if every part is an add whose very event is there
        and the calendar made that event after the approval (the provider's created field); a move
        found at its time, or an event made before the approval, could be anyone's, so unverified.
        Its parts are kept, so an unverified one joins the same follow-up reads."""
        try:
            plan = json.loads(p["settle_json"] or "{}") if p["x_state"] else {}
        except (ValueError, TypeError):
            plan = {}
        if not p["x_state"]:
            try:
                parts, _ = self._plan_all(json.loads(p["params_json"]), p["id"])
            except (Refuse, ValueError, KeyError, TypeError, ical.Unreadable, ics_edit.Cant):
                return "unverified", [], []
            approved = self._approved_at(p)
            ours = bool(parts) and all(part.already and part.change.get("op") == "add" and part.created
                                       and approved is not None
                                       and datetime.fromisoformat(part.created) > approved for part in parts)
            return ("done" if ours else "unverified"), [], [self._part_record(part) for part in parts]
        landed, whole = [], bool(plan.get("parts"))
        for part in plan.get("parts") or []:
            for rec in part.get("steps", []):
                entry = rec.get("entry")
                if rec.get("status") == "landed" and rec.get("kind") == "as_asked":
                    continue                         # the calendar showed it as asked: nothing of ours
                if rec.get("status") in ("landed", "trying", "unsure") and entry:
                    seen, _ = self._seen_as(entry)
                    if seen == "landed" or (rec["status"] == "landed" and seen == "unread"):
                        landed.append(entry)
                        continue
                whole = False
        return ("done" if whole else "unverified"), landed, list(plan.get("parts") or [])

    def found_now(self, proposal_id: str) -> bool:
        """Before Propose again (migrate.py): a read of the request's slot. A change kept as unverified
        whose parts the calendar now shows is confirmed, with "Confirmed."; True then, and it isn't
        offered again. Anything else (a replaced card, a read that can't tell) is False."""
        row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (proposal_id,)).fetchone()
        if row is None or row["state"] not in ("unverified", "absent"):
            return False
        plan = _plan(row)
        parts = [part for part in plan.get("parts") or [] if part.get("expect") and not part.get("already")]
        if not parts or self._reads_done(parts) != "done":
            return False
        plan.pop("recheck", None)
        plan.pop("watch_next", None)
        if row["state"] == "absent":
            self._done_after_all(proposal_id, plan, self._sent_entries(plan, row))
        else:
            self._confirmed(row, plan, parts)
        return True

    def _approved_at(self, p) -> datetime | None:
        stamps = [r[0] for r in self.ledger.db.execute(
            "SELECT consumed_at FROM approvals WHERE proposal_id=? AND consumed_at IS NOT NULL", (p["id"],))]
        stamps = stamps or [p["created_at"]]
        try:
            return min(datetime.fromisoformat(x) for x in stamps if x)
        except ValueError:
            return None

    def record_in_flight(self, db, p, verdict: str, landed: list[dict], parts: list[dict] | None = None) -> None:
        """migrate.py: a change in flight from the version before, recorded as the read found it,
        with its receipt and Undo for what landed. Nothing of it is written again. One unverified
        joins the follow-up reads (30 seconds, 2 minutes, the long window, then watched by id)."""
        now = iso(self.ledger.now())
        row = db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (p["id"],)).fetchone()
        plan = _plan(row) if row is not None else {}
        plan["migrated"] = verdict
        if not plan.get("parts") and parts:
            plan["parts"] = parts
        if verdict != "done" and plan.get("parts"):
            followed = [i for i, part in enumerate(plan["parts"]) if part.get("expect") and not part.get("already")]
            if followed:
                self._schedule_reads(plan, followed)
        undo = (json.loads(row["undo_json"] or "[]") if row is not None else [])
        undo += [e for e in landed if e not in undo]
        state = "done" if verdict == "done" else "unverified"
        if row is None:
            db.execute("INSERT INTO calendar_changes(proposal_id, job_id, state, undo_state, undo_json, created_at,"
                       " updated_at, settle_json) VALUES(?,?,?,?,?,?,?,?)",
                       (p["id"], p["job_id"], state, "open" if undo else "none", json.dumps(undo), now, now,
                        json.dumps(plan)))
        else:
            db.execute("UPDATE calendar_changes SET state=?, undo_state=?, undo_json=?, settle_json=?, updated_at=?"
                       " WHERE proposal_id=? AND state IN ('sending','settling')",
                       (state, "open" if undo else "none", json.dumps(undo), json.dumps(plan), now, p["id"]))
        db.execute("UPDATE proposals SET state=? WHERE id=? AND state IN ('approved','auto_approved','executing')",
                   ("executed" if verdict == "done" else "failed", p["id"]))
        job = db.execute("SELECT state FROM jobs WHERE id=?", (p["job_id"],)).fetchone()
        if job is not None and job["state"] == "approved":
            self.ledger.transition(p["job_id"], "executed" if verdict == "done" else "failed", db=db,
                                   receipt=json.dumps({"reason": "migrated", "read": verdict}))
        raw = self.ledger.get_meta(f"calendar_change_lines:{p['id']}")
        try:
            said = "; ".join(render.plain(x) for x in json.loads(raw)) if raw else ""
        except ValueError:
            said = ""
        if not said:
            try:
                said = "; ".join(render.change_line(c, self.tz, self.ledger.now())
                                 for c in json.loads(p["params_json"])["changes"])
            except (ValueError, KeyError, TypeError):
                said = ""
        said = said or "; ".join(part.get("will", "") for part in plan.get("parts", [])) or "that calendar change"
        if verdict == "done":
            words = (f"<b>Done.</b> {_safe(said)}. It was being written when Harness updated, and a read of the "
                     "calendar after the update shows it done.")
        else:
            words = (f"<b>Not confirmed:</b> {_safe(said)}. It was approved when Harness updated, and a read of "
                     "the calendar after the update doesn't show it done, so nothing of it was written again."
                     + (" I'll read the calendar for it again, and you'll hear if it shows up."
                        if plan.get("recheck") else "")
                     + (" Undo puts back the part that went through." if undo else ""))
        buttons, binds = self._undo_button(db, p["id"]) if undo else (None, None)
        self._say(db, self.chat_id, p["job_id"], words, buttons=buttons, binds=binds)

    def in_flight(self, proposal_id: str) -> bool:
        """Approved and not yet settled: being written, or waiting for a read."""
        p = self.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (proposal_id,)).fetchone()
        if p is not None and p["state"] in ("approved", "auto_approved", "executing"):
            return True
        row = self.ledger.db.execute("SELECT state FROM calendar_changes WHERE proposal_id=?",
                                     (proposal_id,)).fetchone()
        return row is not None and row["state"] in ("sending", "settling")

    def _family_ids(self, job_id: str) -> list[str]:
        root = self.ledger.get_meta(f"job_parent:{job_id}") or job_id
        return list(dict.fromkeys([root, job_id] + json.loads(self.ledger.get_meta(f"job_parts:{root}") or "[]")))

    def _fast_path_holds(self, p) -> str:
        """For a change going through with no tap: why it can't any more, or "". His message must
        still be his newest and under 2 minutes old (fast_check, a fresh read of the DM), and no
        card may be open or replaced for it (0.24.0, third round)."""
        if p["state"] != "auto_approved":
            return ""
        if not fast_path_on(self.ledger):
            return "changes go through without a tap only once the check after installing has passed"
        try:
            cals = {c["calendar"] for c in json.loads(p["params_json"])["changes"]}
        except (ValueError, KeyError, TypeError):
            cals = set(SMOKE_PROVIDERS)
        if self._recent_write_on(cals):
            # Seventh round: a write of ours on that calendar is younger than the listing lag the smoke run
            # measured, so the reads that judge duplicates may not show it yet.
            return ("a change of mine on that calendar was written moments ago, within the time its listing "
                    "takes to show new events, so this one waits for your tap")
        if self.fast_check is None:
            return ""
        try:
            got = self.fast_check(p)
            why, newest = got if isinstance(got, tuple) else (got or "", "")
            if newest:
                self._fast_seen[p["id"]] = newest
            return why or ""
        except Exception as e:                  # a check that can't be made isn't a pass
            log.warning("fast path check failed: %s", type(e).__name__)
            return "I couldn't read the DM to see that it's still your newest message"

    def _card_open_for(self, db, p) -> bool:
        ids = self._family_ids(p["job_id"])
        marks = ",".join("?" * len(ids))
        return db.execute(f"SELECT 1 FROM proposals WHERE job_id IN ({marks}) AND id<>? AND state IN"
                          " ('proposed','superseded') LIMIT 1", (*ids, p["id"])).fetchone() is not None

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
        # Seventh and eighth rounds: after an install, a calendar's cards are held until the smoke run has
        # read back a fenced edit and a series-day edit there (closed_providers). A card from before that
        # (offered before the install) isn't applied: it's held the same way, with no Approve, and comes
        # back on a fresh card once that calendar's gate opens (release_held).
        closed = [x for x in self.providers_of(params, (self.bound_of(p["id"]) or {}).get("bound"))
                  if x in closed_providers(self.ledger)]
        if closed and not self._smoke_tag(p):
            names = " and ".join(provider_name(x) for x in closed)
            log.info("calendar change job %s: held, the card path waits for the smoke run (%s)",
                     render.short(p["job_id"]), names)
            if self.to_card is not None:
                self.to_card(p, f"the check after installing hasn't finished on {names} yet")
            else:
                self._refused(p, "gated", "Nothing changed: after an update, calendar changes wait until the check "
                                          f"after installing has finished on {names}. Cain starts that check.")
            return
        # The fast path, checked again at the moment of the write (0.24.0, third round): his message
        # still his newest and fresh (a read of the DM just now), and, in the same transaction that
        # takes the change, no card open or replaced for it. Either fails: his card, nothing written.
        why = self._fast_path_holds(p)
        if not why and self.live_abandoned() >= MAX_ABANDONED:
            # 0.24.0, fifth round: too many writes still running past their wait. No new write goes
            # out; the change comes back on a card saying writes are paused.
            why = ("writes to your calendars are paused: earlier writes haven't answered yet, and each ends "
                   f"by itself within {self.write_deadline_s} seconds")
            log.warning("%d abandoned writes still running: writes paused", self.live_abandoned())
        # Recorded before anything else, so a crash from here on can never run it twice.
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            if p["state"] == "auto_approved" and not why and self._card_open_for(db, p):
                why = "there's a card open for it"
            if why:
                took = False
            else:
                took = db.execute("UPDATE proposals SET state='executing' WHERE id=? AND state=?",
                                  (p["id"], p["state"])).rowcount == 1
            if took and p["state"] == "auto_approved":
                # The newest message of his the re-check saw, recorded with the claim itself: the DM
                # read right after the write is measured against it (_finish).
                self.ledger.set_meta(f"calendar_change_fast_seen:{p['id']}",
                                     self._fast_seen.pop(p["id"], "") or "-", db)
            if took:
                db.execute("INSERT INTO calendar_changes(proposal_id, job_id, state, undo_state,"
                           " undo_json, created_at, updated_at, settle_json) VALUES(?,?,?,?,?,?,?,?)",
                           (p["id"], p["job_id"], "sending", "none", "[]", now, now,
                            json.dumps({"planning": True})))     # no write before its plan is kept
        if why:
            log.info("calendar change job %s: no longer for the fast path (%s): his card instead",
                     render.short(p["job_id"]), why)
            if why.startswith("writes to your calendars are paused"):
                # Kept in the ledger (sixth round), so once fewer writes are running, this one or a
                # restart offers it again on a fresh card (_resume_paused).
                self.ledger.set_meta(f"{PAUSED}{p['job_id']}", iso(self.ledger.now()))
            if self.to_card is not None:
                self.to_card(p, why)
            else:
                self._refused(p, "changed", f"Nothing changed: {why}.")
            return
        if not took:
            return                                   # his tap or a newer card got there first
        self._smoke_now = self._smoke_tag(p)         # the run's adds are tagged as tests (_add_part)
        self._smoke_nonce = self._step_nonce(p) if self._smoke_now else ""
        try:
            parts, notes = self._plan_all(params, p["id"])
        except Refuse as why:
            self._smoke_now = ""
            adopted = self._adopt_late(p, None, None)
            if adopted:
                self._done_by_earlier(p, adopted)
                return
            self._refused(p, "not_found", f"Nothing changed: {_safe(str(why))}.")
            return
        except (ValueError, KeyError, TypeError, ical.Unreadable, ics_edit.Cant):
            self._smoke_now = ""
            self._refused(p, "unreadable", "Nothing changed: I couldn't read one of those events.")
            return
        self._smoke_now = ""
        drift = self._drifted(p["id"], parts)
        if drift:
            self._refused(p, "changed", f"Nothing changed: {drift}")
            return
        # Every write it will make, recorded before the first: a restart from here on is read, step
        # by step, never guessed at and never run twice (_fail_orphans, _settle).
        plan = {"notes": notes, "since": None, "read_at": None, "passes": 0, "told": False,
                "retried": False, "parts": [self._part_record(part) for part in parts]}
        smoke = self._smoke_tag(p)
        if smoke:
            plan["smoke"] = smoke                    # judged later from this record (smoke_evidence)
        self._late_probe = bool(smoke) and smoke_run(self.ledger).get("late_probe") == "pending" \
            and any(part.adds for part in parts)
        self._save_plan(p["id"], plan)
        undo, results, unsure = [], [], False
        for pi, part in enumerate(parts):
            landed, stopped, at = [], None, None
            for si, step in enumerate(part.steps):
                rec = plan["parts"][pi]["steps"][si]
                outcome, entry, stopped = self._run_step(p["id"], plan, rec, step)
                if outcome == "landed":
                    landed.append(step)
                    if entry:
                        undo.append(entry)
                    elif "already as asked" not in " ".join(notes):
                        notes = notes + ["The calendar turned down my write for an older version of the event, "
                                         "and a read of it by its id shows it already as asked, so there's "
                                         "nothing of mine there to undo."]
                    continue
                at = step
                unsure = unsure or outcome == "unsure"
                break                                # the rest of this part needs this step; other parts go on
            results.append((part, landed, stopped, at))
        self.touched = self.touched or bool(undo) or unsure
        self._late_probe = False
        if unsure:
            self._wait_for_read(p["id"], plan)       # he hears once a read settles it (_settle)
            return
        self._late_probe = False
        adopted = self._adopt_late(p, parts, plan)
        if adopted:
            # A stale refusal whose event an earlier write of the family is found to have taken: done.
            ids = {e.get("id") or caldav.href_path(e.get("href") or "").rsplit("/", 1)[-1] for e in adopted}
            results = [(part, landed, None if s is not None and s.kind == "stale" and not landed
                        and {b.get("id") for b in part.bound} & ids else s, at)
                       for part, landed, s, at in results]
            undo = undo + [e for e in adopted if e not in undo]
            notes = [n for n in notes if "nothing of mine there to undo" not in n] + [
                "Your earlier approval's write went through late, so this one found it already on the calendar: "
                "it's there once, and Undo puts it back."]
        self._finish(p, results, undo, notes, after_all=bool(adopted))

    def _earlier_cards(self, pid: str) -> list[str]:
        """The proposals this one was offered again from (inherit_keys)."""
        return [r[0].split(":", 1)[1] for r in self.ledger.db.execute(
            "SELECT key FROM meta WHERE key LIKE 'calendar_change_reoffer:%' AND value=?", (pid,))]

    def family_root(self, pid: str) -> str:
        """The first offer of the change a proposal is for (seventh round): the proposal its fixed ids
        were first made under (keys_of), or itself."""
        for k in self.keys_of(pid):
            if ":" in k:
                return k.rsplit(":", 1)[0]
        return pid

    def family_members(self, pid: str) -> list[str]:
        """Every proposal of one change family (seventh round): its first offer, each card it was
        offered again on (after a lapse, as Not confirmed, when writes were paused, or as the fresh card
        after a stale refusal), linked by the key their fixed ids share or by the offered-again links.
        A late landing of any of them takes every open card of the family off, and a refusal for its
        version reads every one of their writes before it calls the change stale."""
        root = self.family_root(pid)
        out = [root, pid]
        for key, value in self.ledger.db.execute("SELECT key, value FROM meta WHERE key LIKE 'calendar_change_keys:%'"):
            try:
                keys = json.loads(value or "[]")
            except ValueError:
                continue
            if isinstance(keys, list) and any(str(k).rsplit(":", 1)[0] == root for k in keys):
                out.append(key.split(":", 1)[1])
        links = {r[0].split(":", 1)[1]: r[1] for r in self.ledger.db.execute(
            "SELECT key, value FROM meta WHERE key LIKE 'calendar_change_reoffer:%'")}
        grew = True
        while grew:
            grew = False
            for old, new in links.items():
                if (old in out) != (new in out):
                    out.append(new if old in out else old)
                    grew = True
        return list(dict.fromkeys(out))

    def _adopt_late(self, p, parts: list[Part] | None, plan: dict | None) -> list[dict]:
        """A change offered again that finds itself already done (an add at its fixed id, a move or
        removal the calendar shows as asked, a write refused for its version whose read by id shows it
        as asked, or the event to take off already gone): before saying nothing of ours is there, the
        ledger is read for a write of the same change from the card it was offered again from,
        abandoned or lapsed with no answer, and that write is read again (sixth round). One the
        calendar shows landed is that earlier write, landed late: its change is recorded as landed
        late, and its Undo moves to this receipt, which says Done after all. [] when there's none, and
        then nothing changes. `parts` None: any of the earlier card's writes (the event wasn't found)."""
        # Seventh round: every other row of the change family, not only the card it was offered again from.
        olds = [x for x in self.family_members(p["id"]) if x != p["id"]]
        if not olds:
            return []
        targets: set[str] | None = None
        if parts is not None:
            targets = set()
            for pi, part in enumerate(parts):
                steps = plan["parts"][pi]["steps"] if plan and pi < len(plan.get("parts", [])) else []
                if not (part.already or any(rec.get("kind") in ("as_asked", "stale") for rec in steps)):
                    continue
                targets |= {b["id"] for b in part.bound if b.get("id")}
                if part.found_id:
                    targets |= {part.found_id, f"{part.found_id}.ics"}
            if not targets:
                return []

        def hits(entry: dict) -> bool:
            if targets is None:
                return True
            if entry.get("cal") == "gmail":
                return entry.get("id") in targets
            return caldav.href_path(entry.get("href") or "").rsplit("/", 1)[-1] in targets
        found: dict[str, list[dict]] = {}
        for old in olds:
            row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (old,)).fetchone()
            if row is None or row["state"] not in ("lapsed", "absent", "unverified"):
                continue
            mine = [rec["entry"] for part in _plan(row).get("parts", []) for rec in part.get("steps", [])
                    if rec.get("entry") and rec.get("status") in ("trying", "unsure") and hits(rec["entry"])]
            if mine and all(self._seen_as(e)[0] == "landed" for e in mine):
                found[old] = mine
        if not found:
            return []
        adopted: list[dict] = []
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            for old, mine in found.items():
                row = db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (old,)).fetchone()
                if row is None or row["state"] not in ("lapsed", "absent", "unverified"):
                    continue
                was = _plan(row)
                was["landed_late"] = now
                was["adopted_by"] = p["id"]
                was.pop("recheck", None)
                was.pop("watch_next", None)
                db.execute("UPDATE calendar_changes SET state='landed_late', undo_state='none', undo_json='[]',"
                           " settle_json=?, updated_at=? WHERE proposal_id=?", (json.dumps(was), now, old))
                db.execute("UPDATE proposals SET state='executed' WHERE id=? AND state='failed'", (old,))
                self.ledger.event("calendar_change_landed_late", {"proposal": old, "found_by": p["id"]}, db=db)
                adopted += [dict(e) for e in mine if e not in adopted]
            if adopted:
                cur = db.execute("SELECT undo_json FROM calendar_changes WHERE proposal_id=?", (p["id"],)).fetchone()
                have = json.loads((cur[0] if cur else "") or "[]")
                db.execute("UPDATE calendar_changes SET undo_json=? WHERE proposal_id=?",
                           (json.dumps(have + [e for e in adopted if e not in have]), p["id"]))
        if adopted:
            log.info("calendar change %s: an earlier approval's write landed late; its Undo moves here",
                     render.short(p["id"]))
            for part in parts or []:
                if part.already and part.found_id:      # ours after all: no Add anyway
                    part.done = part.done.split(". Add anyway")[0].replace("Already there, nothing added: ",
                                                                           "On the calendar: ")
                    part.already = ""
        return adopted

    def _done_by_earlier(self, p, adopted: list[dict]) -> None:
        """The event to change wasn't found, and an earlier approval's write of the same change is
        what took it (_adopt_late): Done after all, with that write's Undo, and nothing written."""
        lines = [x for old in self._earlier_cards(p["id"])
                 for x in json.loads(self.ledger.get_meta(f"calendar_change_lines:{old}") or "[]")][:3]
        names = "; ".join(render.plain(x) for x in lines) or "that change"
        with self.ledger.tx() as db:
            now = iso(self.ledger.now())
            db.execute("UPDATE proposals SET state='executed' WHERE id=?", (p["id"],))
            db.execute("UPDATE calendar_changes SET state='done', undo_state='open', updated_at=? WHERE proposal_id=?",
                       (now, p["id"]))
            self.ledger.transition(p["job_id"], "executed", db=db, receipt=json.dumps(
                {"effect": effects.CALENDAR_CHANGE, "outcome": "done_earlier", "steps": len(adopted)}))
            buttons, binds = self._undo_button(db, p["id"])
            self._say(db, self.chat_id, p["job_id"], f"<b>Done after all:</b> {_safe(names)}. Your earlier "
                      "approval's write went through late, so there was nothing left for this one to do. Undo puts "
                      "it back.", buttons=buttons, binds=binds)

    # -- each write, recorded so a read can settle it -----------------------------------------
    def _part_record(self, part: Part) -> dict:
        return {"will": part.will, "done": part.done, "name": part.name, "adds": part.adds,
                "bound": part.bound, "already": part.already, "expect": part.expect, "loose": part.loose,
                "change": part.change,
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
        # Its fencing token, kept in the ledger before the write goes out (0.24.0, fourth round): a
        # write that answers after its change lapsed carries a token that isn't current any more.
        fence = f"{pid}#{plan['seq']}"
        entry["fence"] = fence
        rec.update(status="trying", entry=dict(entry), seq=plan["seq"], fence=fence, sent=iso(self.ledger.now()))
        plan["read_at"] = iso(self.ledger.now())       # sent now: read a minute on, if it comes to that
        with self.ledger.tx() as db:
            self._save_plan(pid, plan, db)
            self.ledger.set_meta(f"calendar_change_fence:{pid}", fence, db)
            if plan.get("smoke") and (rec.get("spec") or {}).get("fn") in ("gmail_add", "family_add"):
                # Ninth round: an event the run's own step creates, kept by id before it's sent; tenth round:
                # with the step's nonce and its day, so it's found by that exact nonce if not by its id.
                c = (rec.get("spec") or {}).get("c") or {}
                self._note_created(plan["smoke"], {**entry, "nonce": c.get("smoke_nonce", ""),
                                                   **self._smoke_days(c)}, db)

    def _bounded(self, calendar: str, call, *args):
        """One write to Google or iCloud, given write_timeout_s (30 seconds, well under the lease)
        and abandoned after it (0.24.0, fourth round): an abandoned write is one whose answer was
        lost ("unknown"), settled by reading like any other, never sent again blind. It keeps
        running on its own thread; if it answers later, that answer is handed back with the write's
        fencing token (_drain_late), so a write that lands after its change lapsed is caught."""
        rec = self._recording
        pid, fence = (rec[0], rec[2].get("fence")) if rec is not None else (None, None)
        box: dict = {}
        lock = threading.Lock()
        done = threading.Event()

        def run() -> None:
            try:
                with net.deadline(self.write_deadline_s):
                    box["out"] = call(*args)
            except BaseException as e:          # handed to the caller, or logged once abandoned
                box["err"] = e
            with lock:
                box["finished"] = True
                late = box.get("late", False)
            done.set()
            if late:
                self._late.put((pid, fence, calendar, box.get("out"), type(box["err"]).__name__
                                if "err" in box else "", getattr(call, "__name__", "")))

        t = threading.Thread(target=run, name=f"calendar-write-{calendar}", daemon=True)
        t.pid = pid                              # type: ignore[attr-defined]
        # The smoke run's first add is let go at once (sixth round): its answer comes late and a read
        # settles it, as for any lost answer. That's the run's late landing, read from the ledger.
        probe = self._late_probe and rec is not None and getattr(call, "__name__", "") in ("insert", "put_new")
        if probe:
            box["late"] = True                   # its answer, whenever it comes, goes the late way
        t.start()
        if probe or not done.wait(self.write_timeout_s):
            with lock:
                abandoned = probe or not box.get("finished")
                if abandoned:
                    box["late"] = True
            if abandoned:
                self.abandoned.append(t)
                log.warning("a write to %s gave no answer in %ss: abandoned, and settled by reading (%s)",
                            calendar, self.write_timeout_s, render.short(pid or "") or "undo")
                if rec is not None:
                    rec[2]["abandoned"] = iso(self.ledger.now())
                if probe:
                    self._late_probe = False
                    run = smoke_run(self.ledger)
                    run["late_probe"] = pid or ""
                    self.ledger.set_meta(SMOKE_RUN, json.dumps(run))
                return caldav.Outcome("unknown")
        if "err" in box:
            raise box["err"]
        return box["out"]

    def _card_bound(self, calendar: str, ident: str) -> list[dict]:
        rec = self._recording
        pid = rec[0] if rec is not None else None
        if not pid or pid == "preview":
            return []
        return [b for b in (self.bound_of(pid) or {}).get("bound", [])
                if b.get("calendar") == calendar and b.get("id") == ident and b.get("etag")]

    def _card_etag(self, calendar: str, ident: str, fresh: str = "", same: Callable[[dict], bool] | None = None,
                   shared: bool = False) -> str:
        """The If-Match a move or removal sends, decided from the read just before the write (0.24.0,
        fifth to eighth rounds). It is always the version that read gave (`fresh`), or nothing is sent.

        The card kept the event's version as its own read found it, and everything it showed of the event
        (_bound_of). Eighth round: a write the calendar is expected to refuse is never sent. When the
        pre-write read shows the event changed since the card, so any field the card bound reads otherwise
        (`same`), or its version differs from the card's and it isn't a day of a series or a shared
        resource whose bound fields all read the same (`shared`), nothing is sent: Stopped("stale",
        unsent), the card is replaced and one fresh card follows for the change family (_finish). A version
        that moved on with every bound field the same on a shared resource (another day's edit in the
        same series) is sent as just read, so the calendar still refuses anything newer than that read.
        "" when the card kept no version (an add, or a proposal from before) and no fresh one is given."""
        bound = self._card_bound(calendar, ident)
        card = bound[0]["etag"] if bound else ""
        if not card:
            return fresh
        if not fresh:
            return card
        printed = same is not None and bool(bound) and all(b.get("print") for b in bound)
        fields_same = printed and all(same(b) for b in bound)
        if _etag_same(card, fresh) and (not printed or fields_same):
            return fresh
        if not _etag_same(card, fresh) and shared and fields_same:
            log.info("%s event's version moved on since its card, and every field the card bound reads the "
                     "same: guarded by the version just read", calendar)
            return fresh
        log.info("%s event %s since its card (card version %s, read just now %s): nothing sent, a fresh card "
                 "instead", calendar, "reads differently" if printed and not fields_same else "has a new version",
                 card, fresh)
        raise self._stale_unsent(calendar, bound, same if printed else None)

    def _stale_unsent(self, calendar: str, bound: list[dict], same: Callable[[dict], bool] | None) -> "Stopped":
        """The pre-write read found the event changed since the card (eighth round): what changed, in
        words for the receipt, and the write's record marked as never sent (the smoke run's evidence)."""
        now = getattr(same, "now", None) if same is not None else None
        changed = _changed_fields(bound[0].get("print") or {}, now) if now else []
        shows = getattr(same, "shows", "") if same is not None else ""
        words = f"its {_and(changed)} changed" if changed else "its version on the calendar changed"
        words = f"a read just before writing shows {words} since your card" + (f"; it now shows {shows}" if shows else "")
        rec = self._recording
        if rec is not None:
            rec[2].update(unsent=True, caught=iso(self.ledger.now()), if_match="", answer="")
        s = Stopped("stale", words=words)
        s.unsent = True
        return s

    def _sent(self, calendar: str, what: str, if_match: str | None, out) -> None:
        """Each move or removal's If-Match, as sent, and the calendar's answer code, in the log and on
        the write's record (sixth round: the smoke test reads both)."""
        status = getattr(out, "status", None)
        log.info("%s %s sent with If-Match %s: answered %s%s", calendar, what, if_match or "(none)",
                 getattr(out, "kind", "?"), f" ({status})" if status else "")
        rec = self._recording
        if rec is not None:
            rec[2].update(if_match=if_match or "", code=status, answer=getattr(out, "kind", ""))

    def _fenced(self, calendar: str, ident: str, want: dict, title: str, href: str = "", sent: str = "") -> None:
        """A move or removal the calendar refused for its version (a precondition failure, 412): the
        event is read by its id and compared with the change: title, start, end, all day or not, and
        repeating or not (0.24.0, fifth round). It shows the change as asked (a correction got there
        first, or someone else took it off): Stopped("as_asked"), Done with nothing of ours to undo.
        Anything else, or a read that can't answer: Stopped("stale") (sixth round): not applied, since
        the calendar refused it, with what the read found on the receipt and a fresh card for the event
        as it is now (_finish). Never unverified, never read for again. Nothing is written again either
        way.

        Seventh and eighth rounds: a refusal for a fence the calendar can't honour is told apart from a
        change. Only when the read by id gives back the very version that was sent did the calendar refuse
        the safety check itself (a weak version under a strong compare, or a version it rewrites):
        Stopped("fence_refused"), one plain Not applied receipt with Try again (a new card from a fresh
        read, a new change family), no fresh card, both versions in the log. A different version, even
        with every bound field the same, is stale: one fresh card."""
        if self._recording is not None and self._recording[3] is not None:
            return                               # a second try's refusal: a read says whose change (_settle)
        log.info("a write to %s was refused for its version: reading the event by its id", calendar)
        shows = ""
        if calendar == "family" and not ident:
            ident = caldav.href_path(href or "").rsplit("/", 1)[-1]
        bound = [b for b in self._card_bound(calendar, ident) if b.get("print")]

        def unchanged(read_etag: str, prints: Callable[[dict], dict | None]) -> None:
            # Eighth round: only the very version that was sent, read back by id, is the calendar refusing
            # its own safety check. A new version with every bound field the same is a change since the
            # write's read (another day's edit, say): the stale path, with one fresh card.
            if bool(sent) and read_etag == sent:
                log.warning("%s refused the write's If-Match %s although a read by id gives version %s, the same "
                            "version: the calendar refused the safety check itself; nothing written, no fresh card",
                            calendar, sent, read_etag)
                raise Stopped("fence_refused", words="this calendar refused the safety check, and a read of the "
                                                     "event by its id gives the very version that was sent")
            if bound and all(_print_same(prints(b), b["print"]) for b in bound):
                log.info("%s refused the write's If-Match %s and a read by id gives version %s with every bound "
                         "field the same: a change since the write's read, so a fresh card", calendar,
                         sent or "(none)", read_etag or "(none)")
                raise Stopped("stale", words="a read of it by its id shows a newer version of it than the one "
                                             "the write was guarded by")
        try:
            if calendar == "gmail":
                kind, ev = self.google.look(self._gmail_address(), ident)
                gone = kind == "gone" or (kind == "ok" and (ev or {}).get("status") == "cancelled")
                if want["kind"] == "gone" and gone:
                    raise Stopped("as_asked")
                if kind == "ok" and ev and not gone:
                    start, end = self._gmail_when(ev.get("start")), self._gmail_when(ev.get("end"))
                    if want["kind"] == "starts" and start is not None and end is not None \
                            and exact_title(ev.get("summary", "")) == exact_title(title) \
                            and _same_start(start, _when(want["start"])) and _same_start(end, _when(want["end"])) \
                            and bool(ev.get("recurringEventId") or ev.get("recurrence")) == bool(want.get("recurring")):
                        raise Stopped("as_asked")
                    unchanged(ev.get("etag") or "", lambda b: self._gmail_print(ev))
                    shows = (f"a read of it by its id shows \u201c{_safe(ev.get('summary', ''))}\u201d at "
                             f"{self._at_words(start, end)}") if start is not None and end is not None else ""
                elif gone:
                    shows = "a read of it by its id finds it gone"
            else:
                out, body = self.client.fetch(href)
                if out.kind == "gone":
                    if want["kind"] in ("gone", "days_off", "ends"):
                        raise Stopped("as_asked")
                    shows = "a read of it by its id finds it gone"
                elif out.kind == "ok":
                    check = want.get("check") or {}
                    today = self._today()
                    occs = self._occurrences(body, *self._bounds([today - timedelta(days=1),
                                                                 today + timedelta(days=400)]))
                    named = {exact_title(o.summary) for o in occs}
                    if check and exact_title(title) in named and self._family_shows(check, body):
                        raise Stopped("as_asked")
                    unchanged(out.etag or "", lambda b: self._family_print(body, b["instance"], self._day_of(b)))
                    shows = "a read of it by its id shows it changed another way" if occs else ""
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, IndexError, ical.Unreadable):
            shows = ""
        raise Stopped("stale", words=(shows or "a read of it by its id didn't answer"))

    def _drain_late(self) -> None:
        """Writes abandoned at their timeout that have answered since (0.24.0, fourth round). One whose
        fencing token is still current is a write still being settled: the reads settle it. One
        whose change lapsed since (its lease ran out and a read twice found it not done) and that
        did land is recorded as landed: its change is done after all, with its receipt and Undo,
        and the card that offered it again comes off, so there's never a second one. A change the
        newer card already wrote finds that write there (its fixed id), and nothing more is
        written."""
        while True:
            try:
                pid, fence, calendar, out, err, name = self._late.get_nowait()
            except queue.Empty:
                return
            kind = getattr(out, "kind", "") or ("error" if err else "unknown")
            if pid is not None and name in ("put_new", "insert") and kind in ("changed", "exists"):
                # iCloud's 412 (If-None-Match) or Google's 409 for an add's fixed id already written
                # (0.24.0, fifth round): never taken for our own write. The event at that id is read
                # and compared with the add: title, start, end, all day or not, repeating or not.
                kind = "exists" if self._add_there(pid, fence) else "other"
            if pid is None:
                log.info("an abandoned undo write to %s answered late (%s); its reads settle it", calendar, kind)
                continue
            current = self.ledger.get_meta(f"calendar_change_fence:{pid}")
            if current == fence:
                log.info("calendar change %s: an abandoned write answered late (%s), still current; "
                         "its reads settle it", render.short(pid), kind)
                continue
            log.info("calendar change %s: a write fenced out by its lapse answered late (%s)",
                     render.short(pid), kind)
            if kind in ("ok", "exists"):
                self._landed_late(pid, fence, already=kind == "exists")

    def _add_there(self, pid: str, fence: str) -> bool:
        """The add a late write was for, read at its own id: there as asked, or not (someone else's
        event at that address, or nothing readable)."""
        row = self.ledger.db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
        plan = _plan(row) if row is not None else {}
        for part in plan.get("parts", []):
            if not any(rec.get("fence") == fence for rec in part.get("steps", [])):
                continue
            want = [e for e in part.get("expect") or [] if e.get("kind") == "there"]
            return bool(want) and all(self._by_id(e, whole=True, recurring=bool(e.get("repeats"))) == "same"
                                      for e in want)
        return False

    def _landed_late(self, pid: str, fence: str, already: bool) -> None:
        row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
        if row is None or row["state"] != "lapsed":
            return
        plan = _plan(row)
        entries = [rec["entry"] for part in plan.get("parts", []) for rec in part["steps"]
                   if rec.get("entry") and rec.get("fence") == fence]
        self._done_after_all(pid, plan, [] if already else entries, already=already)

    def _done_after_all(self, pid: str, plan: dict, entries: list[dict], already: bool = False) -> None:
        """A change that lapsed, or was said as not found, that the calendar now shows (a write that
        answered late, or a later read): Done after all, with Undo for what it wrote, and the card that
        offered it again comes off, so there's never a second one (0.24.0, fourth and fifth rounds). A
        card offered again that he has approved and that hasn't run yet is replaced the same way; one
        already running or done says its own receipt, so this says nothing more. Sixth round: the
        receipt quotes his request, the day he asked and how it was approved; one he declined when it
        was offered again says it landed although he declined, with Undo first; and one more than a
        day old says how old the request is."""
        row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
        if row is None or p is None or row["state"] not in ("lapsed", "absent"):
            return
        # Seventh round: every open card of the change family comes off, not only the one it was
        # offered again on: the fresh card after a stale refusal is one of them.
        members = [x for x in self.family_members(pid) if x != pid]
        revert_ok = bool(entries) and all(e.get("how") in ("drop", "delete") and self._add_as_written(e)
                                          for e in entries)
        undo_now = json.loads(row["undo_json"] or "[]")
        undo_now += [e for e in entries if e not in undo_now]
        with self.ledger.tx() as db:
            took_card, declined, quiet = False, False, False
            from . import approvals
            for newer in members:
                st = (db.execute("SELECT state FROM proposals WHERE id=?", (newer,)).fetchone() or {"state": ""})["state"]
                took = approvals.supersede(self.ledger, newer, db=db, outcome="landed")
                if not took and st in ("approved", "auto_approved"):
                    # Approved and not yet run: it never runs (one compare-and-set on its state).
                    took = db.execute("UPDATE proposals SET state='superseded' WHERE id=? AND state=?",
                                      (newer, st)).rowcount == 1
                declined = declined or st == "declined"
                quiet = quiet or st in ("executing", "executed")
                if took:
                    took_card = True
                    job = db.execute("SELECT job_id FROM proposals WHERE id=?", (newer,)).fetchone()
                    jst = db.execute("SELECT state FROM jobs WHERE id=?", (job[0],)).fetchone() if job else None
                    if jst is not None and jst["state"] in ("proposed", "approved"):
                        # Approved and not run: done all the same, by the earlier write.
                        self.ledger.transition(job[0], "cancelled" if jst["state"] == "proposed" else "executed",
                                               db=db, receipt=json.dumps({"reason": "landed_late"}))
            undo = undo_now
            plan["landed_late"] = iso(self.ledger.now())
            plan.pop("recheck", None)
            plan.pop("watch_next", None)
            # Seventh round: declined, and only plain adds that still read as they were written: taken off
            # again by itself, through Undo's own reads and version checks, and said so.
            revert = declined and not quiet and bool(undo) and bool(entries) and revert_ok
            if revert:
                plan["auto_revert"] = iso(self.ledger.now())
            db.execute("UPDATE calendar_changes SET state='landed_late', undo_json=?, undo_state=?, settle_json=?,"
                       " updated_at=? WHERE proposal_id=? AND state IN ('lapsed','absent')",
                       (json.dumps(undo), "requested" if revert else "open" if undo else row["undo_state"],
                        json.dumps(plan), iso(self.ledger.now()), pid))
            db.execute("UPDATE proposals SET state='executed' WHERE id=? AND state='failed'", (pid,))
            self.ledger.event("calendar_change_landed_late", {"proposal": pid, "card_off": took_card,
                                                              "declined": declined}, db=db)
            if quiet and not declined:
                return
            if revert:
                # Eighth round: the revert is made now and its outcome goes on this same receipt (below).
                # Kept as requested meanwhile, so a restart before that finishes it through Undo's reads.
                pass
            elif took_card or declined or not already:
                names = "; ".join(part["will"] for part in plan.get("parts", []) if part.get("will"))
                asked = self._request_words(p)
                if declined:
                    words = (f"<b>Applied despite your Decline:</b> {names}. Undo comes first: it takes it off "
                             "again. An earlier write of it landed late, after you declined it when I offered it "
                             "again, and it has changed since it was written, so I've left it for you.")
                elif row["state"] == "absent":
                    words = f"<b>Done after all:</b> {names}. A later read of the calendar shows it as asked."
                else:
                    words = (f"<b>Done after all:</b> {names}. That went through late, after I'd offered it "
                             "again" + (", so the newer card is off and nothing is added twice." if took_card else
                                        "; the newer one found it there, so it's on the calendar once."
                                        if already else "."))
                words += ("\n" + asked) if asked else ""
                # After his Decline, Undo is first and lasts longer than the usual window (DECLINED_UNDO_TTL_S).
                buttons, binds = (self._undo_button(db, pid, ttl_s=DECLINED_UNDO_TTL_S if declined else UNDO_TTL_S)
                                  if undo else (None, None))
                self._say(db, self.chat_id, p["job_id"], words, buttons=buttons, binds=binds)
        if revert:
            self._revert_declined(p, plan, entries)

    def _revert_declined(self, p, plan: dict, entries: list[dict]) -> None:
        """A plain add that landed after his Decline, still as written, taken off again now, each with the
        version just read as its guard, and one receipt that says how that went (eighth round): taken off;
        turned down, with Undo kept (first, for 30 days); or not known yet, still read under the watch
        (Undo's own reads finish it and say so)."""
        pid = p["id"]
        outcome = "reverted"
        for e in entries:
            got = self._revert_one(e)
            if got == "failed" or (got == "unknown" and outcome == "reverted"):
                outcome = got
        names = "; ".join(part["will"] for part in plan.get("parts", []) if part.get("will"))
        asked = self._request_words(p)
        head = (f"<b>Applied despite your Decline:</b> {names}. An earlier write of it landed late, after you "
                "declined it when I offered it again. Since you declined it and it was still just as written, I "
                "took it off again, only over that version: ")
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            buttons = binds = None
            if outcome == "reverted":
                words = head + "it's off your calendar now, and a read of it by its id shows it gone."
                plan.update(undone_at=now, undone_entries=entries)
                db.execute("UPDATE calendar_changes SET undo_state='undone', settle_json=?, updated_at=? WHERE "
                           "proposal_id=? AND undo_state='requested'", (json.dumps(plan), now, pid))
            elif outcome == "failed":
                words = (head + "the calendar turned that down, so it's still there. Undo comes first and takes it "
                         "off when you tap it.")
                db.execute("UPDATE calendar_changes SET undo_state='open', updated_at=? WHERE proposal_id=? AND "
                           "undo_state='requested'", (now, pid))
                buttons, binds = self._undo_button(db, pid, ttl_s=DECLINED_UNDO_TTL_S)
            else:
                words = (head + "the calendar's answer didn't come back, so whether it's off isn't known yet. I'm "
                         "reading it, and the outcome follows.")
            self.ledger.event("calendar_change_declined_revert", {"proposal": pid, "outcome": outcome}, db=db)
            self._say(db, self.chat_id, p["job_id"], words + (("\n" + asked) if asked else ""),
                      buttons=buttons, binds=binds)
        log.info("calendar change %s: landed after his Decline, taken off again: %s", render.short(pid), outcome)

    def _revert_one(self, e: dict) -> str:
        """One plain add of ours taken off, guarded by the version just read: "reverted", "failed" (turned
        down, or changed since) or "unknown" (no answer, or a read after that can't tell)."""
        try:
            if e.get("cal") == "gmail":
                address = self._gmail_address()
                kind, now = self.google.look(address, e["id"])
                if kind == "gone" or (kind == "ok" and (now or {}).get("status") == "cancelled"):
                    return "reverted"
                if kind != "ok" or not now:
                    return "unknown"
                if not self._as_written(now, e.get("wrote") or {}):
                    return "failed"
                out = self.google.drop(address, e["id"], now.get("etag"))
                if out.kind == "unknown":
                    return "unknown"
                if out.kind != "ok":
                    return "failed"
                return "reverted" if self.google.really_gone(address, e["id"]) else "unknown"
            got, body = self.client.fetch(e["href"])
            if got.kind == "gone":
                return "reverted"
            if got.kind != "ok":
                return "unknown"
            if not (caldav._unchanged(body, e.get("after") or "") or caldav._unchanged(body, e.get("sent") or "")):
                return "failed"
            out = self.client.remove_at(e["href"], got.etag)
            if out.kind == "unknown":
                return "unknown"
            if out.kind != "ok":
                return "failed"
            back, _ = self.client.fetch(e["href"])
            return "reverted" if back.kind == "gone" else "unknown"
        except (Refuse, ValueError, KeyError, TypeError, AttributeError):
            return "unknown"

    def _add_as_written(self, e: dict) -> bool:
        """A plain add of ours, read by its id now, still exactly as it was written (seventh round)."""
        try:
            if e.get("cal") == "gmail":
                kind, now = self.google.look(self._gmail_address(), e["id"])
                return kind == "ok" and bool(now) and now.get("status") != "cancelled" \
                    and self._as_written(now, e.get("wrote") or {})
            out, body = self.client.fetch(e["href"])
            return out.kind == "ok" and (caldav._unchanged(body, e.get("after") or "")
                                         or caldav._unchanged(body, e.get("sent") or ""))
        except (Refuse, ValueError, KeyError, TypeError, AttributeError):
            return False

    def _request_words(self, p) -> str:
        """His request a late receipt is for (sixth round): his words quoted, the day he asked, how it
        was approved, and how old it is when that's more than a day. HTML-safe; "" when none is kept."""
        try:
            job = self.ledger.job(p["job_id"])
            root = self.ledger.get_meta(f"job_parent:{p['job_id']}") or p["job_id"]
            origin = json.loads(self.ledger.get_meta(f"job_origin:{p['job_id']}")
                                or self.ledger.get_meta(f"job_origin:{root}") or "{}")
            his = self.ledger.job_text(p["job_id"]).split("\n\n[A suggestion from Cain", 1)[0]
            quote = provenance.one_line(origin.get("quote") or his, 100)
            sent = datetime.fromisoformat(origin.get("sent_at") or job["created_at"])
        except (ValueError, KeyError, TypeError, AttributeError):
            return ""
        local = sent.astimezone(ZoneInfo(self.tz))
        when = f"{local:%a %b} {local.day} at {render.clock_words(local, suffix=True)}"
        tapped = self.ledger.db.execute("SELECT consumed_at FROM approvals WHERE proposal_id=? AND consumed_at"
                                        " IS NOT NULL AND outcome='approve' ORDER BY consumed_at LIMIT 1",
                                        (p["id"],)).fetchone()
        auto = self.ledger.db.execute("SELECT 1 FROM events WHERE kind='calendar_change_auto' AND detail LIKE ?",
                                      (f'%{p["id"]}%',)).fetchone()
        if tapped is not None:
            t = datetime.fromisoformat(tapped[0]).astimezone(ZoneInfo(self.tz))
            how = f"You approved it on its card at {render.clock_words(t, suffix=True)}."
        elif auto is not None:
            how = "It went without a card, from your own fresh message."
        else:
            how = ""
        out = (f"Your request: \u201c{render.escape(quote)}\u201d, asked {when}." if quote
               else f"Asked {when}.") + (f" {how}" if how else "")
        age = self.ledger.now() - sent
        if age > timedelta(days=1):
            days = age.days
            out += f" That request is {days} day{'s' * (days != 1)} old." if days >= 2 else \
                f" That request is {int(age.total_seconds() // 3600)} hours old."
        return out

    def _resume_paused(self) -> None:
        """Changes that came back on a card because writes were paused (sixth round): once fewer than
        MAX_ABANDONED writes are still running (only threads still alive count, so the number drops as
        each ends at its deadline, and a restart starts from none), each card still open is replaced by
        a fresh one saying writes have resumed, for his tap. One he already answered is left alone."""
        keys = [r[0] for r in self.ledger.db.execute("SELECT key FROM meta WHERE key LIKE ?", (f"{PAUSED}%",))]
        if not keys or self.live_abandoned() >= MAX_ABANDONED:
            return
        for key in keys:
            job_id = key[len(PAUSED):]
            open_ = self.ledger.db.execute(
                "SELECT * FROM proposals WHERE job_id=? AND effect_type=? AND state='proposed' ORDER BY created_at"
                " DESC LIMIT 1", (job_id, effects.CALENDAR_CHANGE)).fetchone()
            with self.ledger.tx() as db:
                db.execute("DELETE FROM meta WHERE key=?", (key,))
                took = False
                if open_ is not None and self.recard is not None:
                    from . import approvals
                    took = approvals.supersede(self.ledger, open_["id"], db=db, outcome="replaced")
            if not took:
                continue
            log.info("calendar change job %s: writes have resumed: its paused card offered again",
                     render.short(job_id))
            try:
                self.recard(open_, json.loads(open_["params_json"])["changes"],
                            "writes to your calendars have resumed, so here it is again", True)
            except (Refuse, ValueError, KeyError, TypeError) as e:
                log.warning("offering a paused change again failed: %s", type(e).__name__)

    def live_abandoned(self, pid: str | None = None) -> int:
        """Abandoned writes still running (of one change, given `pid`)."""
        self.abandoned = [t for t in self.abandoned if t.is_alive()]
        return sum(1 for t in self.abandoned if pid is None or getattr(t, "pid", None) == pid)

    def join_abandoned(self, timeout: float = 5.0) -> None:
        """Tests: wait for abandoned writes to answer."""
        for t in self.abandoned:
            t.join(timeout)
        self.abandoned = [t for t in self.abandoned if t.is_alive()]

    def _run_step(self, pid: str, plan: dict, rec: dict, step: Step, unsure_if: tuple[str, ...] = ("unknown",),
                  guard: str | None = None) -> tuple[str, dict | None, Stopped | None]:
        """One step: "landed" and its undo entry; "unsure" (written, or maybe written, and not
        confirmed: a read settles it); or "failed", with nothing written. `guard`: a retry's
        version, the one nothing landed on, which the fresh read must find before it writes."""
        self._recording = (pid, plan, rec, guard)
        try:
            entry = step.run()
        except Stopped as s:
            if s.kind == "as_asked":
                # Refused for its version, and a read by id shows the change as asked (_fenced):
                # done, with nothing of ours on the calendar for Undo to put back.
                self._recording = None
                rec.update(status="landed", entry=None, kind="as_asked", words="")
                self._save_plan(pid, plan)
                return "landed", None, None
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
            self._gate_blocked(plan, rec, stopped)
            return "failed", None, stopped
        full = {**entry, "removed": [list(x[:3]) for x in step.removed], **({"rows": step.rows} if step.rows else {})}
        # Its records are kept as if it landed even while unsure, so a read from before the write
        # can't undo it; a read that finds it didn't land puts them back (_unapply).
        rec.update(status="landed" if stopped is None else "unsure", entry=full, kind="", words="", applied=True)
        if stopped is None:
            rec["back"] = iso(self.ledger.now())     # read back as asked: when (the smoke run's evidence)
            self._note_verified(plan, rec)
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
        keys = self.keys_of(pid)
        self._forcing = bool(self.ledger.get_meta(f"calendar_change_force:{pid}"))
        skip = self._skipped(pid)
        for index, change in enumerate(params["changes"]):
            if index in skip:
                continue                       # seventeenth round: the calendar already shows it (skip_found)
            # Each add's fixed id comes from the proposal it was first offered under (keys_of), so a
            # change offered again writes to the same address and never makes a second event.
            more, said_here = self._plan(change, keys[index] if index < len(keys) else f"{pid}:{index}")
            notes += said_here
            for part in more:
                part.change = part.change or dict(change)    # what to offer again on a fresh card
                same = next((x for x in parts if part.key and x.key and x.key[0] & part.key[0]), None)
                if same is None:
                    parts.append(part)
                elif same.key != part.key:
                    raise Unclear(f"you asked for two different changes to one event: "
                                  f"{render.plain(same.will)}, and {render.plain(part.will)}", "Which one?")
        return parts, notes

    def keys_of(self, pid: str) -> list[str]:
        """The key each change's fixed id is made from: the proposal and place it was first offered
        under (0.24.0, fourth round), kept when a change is offered again (inherit_keys)."""
        try:
            got = json.loads(self.ledger.get_meta(f"calendar_change_keys:{pid}") or "[]")
        except ValueError:
            return []
        return [str(k) for k in got] if isinstance(got, list) else []

    def inherit_keys(self, new_pid: str, changes: list[dict], earlier: dict, db) -> list[str]:
        """A change offered again (after its lease ran out, as Not confirmed, or replaced when Harness
        updated) keeps the key of its first offer, so its add writes to the same fixed id and finds
        an earlier write that landed instead of making a second event. `earlier`: each change's
        key (runner._change_key) to the key it was first offered under."""
        keys = [earlier.get(_offer_key(c), f"{new_pid}:{i}") for i, c in enumerate(changes)]
        olds: list[str] = []
        if any(k != f"{new_pid}:{i}" for i, k in enumerate(keys)):
            self.ledger.set_meta(f"calendar_change_keys:{new_pid}", json.dumps(keys), db)
            for k in keys:
                old = k.rsplit(":", 1)[0]
                if old != new_pid:
                    self.ledger.set_meta(f"calendar_change_reoffer:{old}", new_pid, db)
                    if old not in olds:
                        olds.append(old)
        return olds

    def inherit_versions(self, new_pid: str, olds: list[str], db) -> None:
        """A move or removal offered again (sixth round) is bound to the version its first card was:
        each event the new card names that the first card named too (same calendar, id and day) takes
        the first card's version and fields, so whichever write lands first, the other is refused by
        the calendar and nothing is done twice."""
        kept = self.bound_of(new_pid)
        if not kept or not kept.get("bound"):
            return
        # Not from a card the calendar refused as stale or whose fence it couldn't honour (seventh round):
        # that version is known to be behind the event.
        olds = [o for o in olds if (self.ledger.db.execute(
            "SELECT state FROM calendar_changes WHERE proposal_id=?", (o,)).fetchone() or {"state": ""})["state"]
            not in ("stale", "fence_refused")]
        firsts = [b for old in olds for b in (self.bound_of(old) or {}).get("bound", []) if b.get("etag")]
        changed = False
        for b in kept["bound"]:
            if b.get("op") not in ("move", "remove"):
                continue
            first = next((x for x in firsts if (x["calendar"], x["id"], x.get("instance")) ==
                          (b["calendar"], b["id"], b.get("instance"))), None)
            if first is not None and first["etag"] != b.get("etag"):
                b["etag"] = first["etag"]
                if first.get("print"):
                    b["print"] = first["print"]
                changed = True
        if changed:
            self.ledger.set_meta(f"calendar_change_bound:{new_pid}", json.dumps(kept), db)

    def keys_by_change(self, pid: str) -> dict:
        """{change key: the key its fixed id is made from} for one proposal's changes."""
        p = self.ledger.db.execute("SELECT params_json FROM proposals WHERE id=?", (pid,)).fetchone()
        if p is None:
            return {}
        try:
            changes = json.loads(p["params_json"])["changes"]
        except (ValueError, KeyError, TypeError):
            return {}
        keys = self.keys_of(pid)
        return {_offer_key(c): (keys[i] if i < len(keys) else f"{pid}:{i}") for i, c in enumerate(changes)}

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

    def _finish(self, p, results: list, undo: list[dict], notes: list[str], after_all: bool = False) -> None:
        """One receipt: what was done, and what wasn't, each by name with why. Never "Nothing
        changed" when something did (Nov 11). Only known outcomes come here: one a read hasn't
        settled waits for it (_settle)."""
        results, notes = self._read_back(results, list(notes))
        newer = self._newer_after_write(p)
        failed = [(part, landed, s, at) for part, landed, s, at in results if s is not None]
        done = [part for part, _, s, _ in results if s is None]
        ok = not failed
        kind = "done" if ok else failed[0][2].kind
        # Refused for its version, and read by id as something else (sixth round): not applied, since the
        # calendar turned it down, and offered again on a fresh card. Never unverified, never read for.
        stale = [part for part, landed, s, _ in failed if s.kind == "stale" and not landed]
        # One fresh card per change family (seventh round): a second stale refusal ends with this receipt.
        root = self.family_root(p["id"])
        capped = bool(stale) and self.ledger.get_meta(f"calendar_change_recarded:{root}") is not None
        if any(s.kind == "read_back" for _, _, s, _ in failed):
            # Written, and the calendar doesn't read back that way: kept as unverified, never as
            # done, and never written again on its own (0.24.0, third round).
            kind = "unverified"
        elif kind == "stale":
            kind = "stale" if stale and failed[0][0] in stale else "changed"
        elif kind == "fence_refused" and any(landed for _, landed, _, _ in failed):
            kind = "changed"
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
            if kind == "unverified":
                # Twelfth round: a write whose read back doesn't show it (its version moved) fails visibly here
                # and counts toward that calendar's gate review: kept in the gate, for the next check after
                # installing and the log. It never re-closes the gate by itself.
                self._count_review(db, [self._step_provider(at) or (part.change or {}).get("calendar", "")
                                        for part, _, st, at in failed if st.kind == "read_back"])
                # Not confirmed isn't the end (0.24.0, fourth round): read again in the background
                # about 30 seconds and 2 minutes on (_recheck_unverified).
                row = db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?", (p["id"],)).fetchone()
                plan = json.loads(row[0]) if row and row[0] else {}
                if plan.get("parts") and len(plan["parts"]) == len(results):
                    self._schedule_reads(plan, [i for i, (_, lnd, st, _) in enumerate(results)
                                                if st is not None and st.kind == "read_back"])
                    self._save_plan(p["id"], plan, db)
            if ok:
                db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
                self.ledger.event("calendar_change_done", {"steps": len(undo)}, db=db)
                row = db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?", (p["id"],)).fetchone()
                kept = json.loads(row[0]) if row and row[0] else {}
                if kept.get("parts"):
                    kept["listed_at"] = now          # the days read as he'd see them show it (the listing lag)
                    self._save_plan(p["id"], kept, db)
                head = ("<b>Done after all.</b>" if after_all
                        else "<b>Nothing added.</b>" if done and all(part.already for part in done) else "<b>Done.</b>")
            else:
                self.ledger.set_meta(PROBLEM, "Calendar change: the last one didn't finish", db)
                head = ("<b>Only part of that went through.</b>" if done
                        else "<b>Not applied.</b>" if all(s.kind in ("stale", "fence_refused", "whole_series")
                                                          and not landed for _, landed, s, _ in failed)
                        else "<b>Not confirmed.</b>" if all(s.kind == "read_back" or (s.kind == "stale" and not landed)
                                                            for _, landed, s, _ in failed)
                        else "<b>That stopped partway.</b>" if any(landed for _, landed, _, _ in failed)
                        else "<b>Not confirmed.</b>" if any(s.kind in ("unconfirmed", "read_back")
                                                            for _, _, s, _ in failed)
                        else "<b>Nothing changed.</b>")
            lines = [head] + [part.done for part in done]
            retry = restart = False
            weak: list[str] = []                  # ninth round: refused on an unchanged event after an override
            for part, landed, s, at in failed:
                why = _safe(s.words or WORDS.get(s.kind) or "the calendar refused it")
                went = " and ".join(dict.fromkeys(x.what for x in landed))
                # Writes on one calendar (two series of one title, say) are part of it there,
                # never "on Family, not on Family".
                if s.kind == "read_back":        # written, and the calendar read back says otherwise
                    lines.append(s.words)
                elif s.kind == "fence_refused" and not landed and self._after_override(
                        self._step_provider(at) or (part.change or {}).get("calendar", "")):
                    # Ninth round: on a calendar opened without the check, a refusal on an unchanged event
                    # means its versions can't guard a write. No Try again there from the first one.
                    provider = self._step_provider(at) or (part.change or {}).get("calendar", "")
                    first = provider not in weak and not ((card_gate(self.ledger).get("override_told") or {})
                                                          .get(provider))
                    weak.append(provider)
                    name = provider_name(provider)
                    if first:
                        # Tenth round: the first such refusal there quotes his request and offers Start again
                        # from now once (a new card from a fresh read); later ones offer nothing.
                        restart = True
                        asked = self._request_words(p)
                        lines.append(f"Not applied: {part.will}. {name} turned down the write at its safety check "
                                     "while the event hadn't changed, so nothing was changed."
                                     + (f" {asked}" if asked else "")
                                     + f" Edits on {name} most likely can't be applied safely: it seems to give a "
                                     "weak or rewritten version (etag) for its events. Start again from now makes "
                                     "one new card from the event as it is now, for your tap; after this no retry "
                                     f"button is offered for {name}.")
                        continue
                    lines.append(f"Not applied: {part.will}. {name} turned down the write at its safety check while "
                                 f"the event hadn't changed, so nothing was changed. Edits on {name} can't be applied "
                                 "safely: it most likely gives a weak or rewritten version (etag) for its events, so "
                                 "its safety check can't tell an unchanged event from a changed one, so no retry "
                                 f"button is offered for {name}.")
                elif s.kind == "fence_refused" and not landed:    # the calendar refused the fence itself
                    retry = True
                    lines.append(f"Not applied: {part.will}. This calendar turned down the write at its safety check, "
                                 "and a read of the event by its id shows the very version the write was guarded "
                                 "by, so nothing was changed. Try again makes a new card from a fresh read of the "
                                 "event, for your tap.")
                elif s.kind == "whole_series" and not landed:     # a series day that read as the whole series
                    lines.append(f"Not applied: {part.will}. The calendar returned the whole series for that day, "
                                 "not the one day, so nothing was changed. To edit it, say to Cain whether you mean "
                                 "only that day or the whole series, and a new card follows.")
                elif s.kind == "stale" and not landed:    # changed since the card: nothing sent, or refused
                    why_stale = (f"The event changed since your card ({s.words}), so nothing was sent to the "
                                 "calendar." if s.unsent else
                                 f"The event changed since your card, so the calendar turned the write down: "
                                 f"{s.words}.")
                    if capped:
                        restart = True
                    lines.append(f"Not applied: {part.will}. {why_stale}"
                                 + (" That was already its fresh card, so nothing was changed. Start again from "
                                    "now makes a new card from the event as it is now, for your tap."
                                    if capped else
                                    " A fresh card with it as it is now follows." if self.recard is not None else ""))
                elif s.kind == "stale":
                    lines.append(f"Partly done: {part.will}. It went through on {went}, not on {at.what}, because "
                                 f"the event changed there since your card: {s.words}.")
                elif s.kind == "unconfirmed":    # reads never could tell, and they've stopped
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
            read_as = self._read_as(p)
            if read_as and done:
                lines.append("Read from your words: " + "; ".join(read_as) + ".")
            if newer:
                root = self.ledger.get_meta(f"job_parent:{p['job_id']}") or p["job_id"]
                for mid in newer:
                    self.ledger.set_meta(f"correction_of:{mid}", root, db)
                lines.append("You sent another message while this was being made, so I'm reading it as a "
                             "correction of this change, not a new request." + (" Undo is here if it "
                                                                                "should come off." if undo else ""))
            buttons, binds = self._undo_button(db, p["id"]) if undo else (None, None)
            # Eighth round: one tap that starts the change over from a fresh read, as a new change family:
            # Try again after the calendar refused its own safety check, Start again from now at the cap.
            for wanted, kind_, label in ((retry, "calendar_change_try_again", "Try again"),
                                         (restart, "calendar_change_restart", "Start again from now")):
                if wanted and self.recard is not None:
                    nonce = choices.mint(self.ledger, kind=kind_, target=p["id"], chat_id=self.chat_id,
                                         ttl_s=UNDO_TTL_S, db=db)
                    buttons = [(buttons or [[]])[0] + [(label, choices.callback_data(nonce))]]
                    binds = (binds or []) + [{"type": "choice", "nonce": nonce}]
            if any(part.already and part.change.get("op") == "add" for part in done):
                # Never silent on a duplicate (0.24.0, fourth round): the event that's there is
                # named, and Add anyway makes the second one if that's what he meant.
                more, more_binds = self._add_anyway_button(db, p["id"])
                buttons, binds = (buttons or [[]]), (binds or [])
                buttons = [buttons[0] + more[0]]
                binds = binds + more_binds
            try:
                cals = self.providers_of(json.loads(p["params_json"]))
            except (ValueError, KeyError, TypeError):
                cals = []
            line = self._unprotected_receipt(p["id"], cals)
            if line:
                lines.append(line)
            self._say(db, self.chat_id, p["job_id"], "\n".join(lines), buttons=buttons, binds=binds)
            if weak:
                self._weak_fence(db, weak)
        log.info("calendar change job %s: %s, %d of %d part(s) done, %d write(s)",
                 render.short(p["job_id"]), kind, len(done), len(results), len(undo))
        if stale and capped:
            log.info("calendar change job %s: refused as stale again in its family; no second fresh card",
                     render.short(p["job_id"]))
        elif stale and self.recard is not None:
            # One fresh card for what the calendar refused, read anew, so it's bound to the event's
            # version now (sixth round). Never applied without his tap. At most one per change family
            # (seventh round), and it joins the family (runner._earlier_keys counts a stale row).
            with self.ledger.tx() as db:
                self.ledger.set_meta(f"calendar_change_recarded:{root}", p["id"], db)
            changes = []
            for part in stale:
                if part.change and part.change not in changes:
                    changes.append(dict(part.change))
            if changes:
                try:
                    self.recard(p, changes, "the event changed since your earlier card, so this is a fresh card "
                                            "with it as it is now", False)
                except (Refuse, ValueError, KeyError, TypeError) as e:
                    log.warning("the fresh card after a refused write failed: %s", type(e).__name__)

    @staticmethod
    def _step_provider(step) -> str:
        fn = (getattr(step, "spec", None) or {}).get("fn", "")
        if fn in ("gmail_end", "family_end"):
            return fn.split("_")[0]
        return _STEP_FN.get(fn, ("", ""))[0]

    def _after_override(self, provider: str) -> bool:
        """Whether this calendar's gate after an install was opened without the check (ninth round)."""
        return bool(provider) and bool((card_gate(self.ledger).get("override") or {}).get(provider))

    def _count_review(self, db, providers: list[str]) -> None:
        gate = card_gate(self.ledger)
        if not gate:
            return
        review = gate.setdefault("review", {})
        for x in providers:
            if x not in SMOKE_PROVIDERS:
                continue
            got = review.setdefault(x, {"read_back_mismatch": 0})
            got["read_back_mismatch"] = int(got.get("read_back_mismatch") or 0) + 1
            got["last"] = iso(self.ledger.now())
            self.ledger.event("calendar_gate_review", {"calendar": x, "read_back_mismatch": got["read_back_mismatch"]},
                              db=db)
            log.warning("%s: a write's read back didn't show it; counted toward its gate review (%d since install)",
                        x, got["read_back_mismatch"])
        self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)

    def _unprotected_receipt(self, pid: str, cals: list[str]) -> str:
        """Eleventh round: every receipt on a calendar opened without protection says so. Twelfth round: so
        does every receipt for a write sent without If-Match for any other reason (a weak version, or none),
        on a calendar that's otherwise protected: never a normal-looking receipt for an unfenced write."""
        row = self.ledger.db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?", (pid,)).fetchone()
        try:
            plan = json.loads(row[0]) if row and row[0] else {}
        except ValueError:
            plan = {}
        sent = {rec.get("rcw_cal"): rec.get("rcw_why", "") for part in plan.get("parts") or []
                for rec in part.get("steps", []) if rec.get("rcw") and rec.get("rcw_cal")}
        opened = [x for x in cals if self._unprotected(x)]
        other = [x for x in sent if x not in opened]
        if not opened and not other:
            return ""
        said = []
        if opened:
            said.append(" and ".join(provider_name(x) for x in opened) + " was changed without the calendar's "
                        "version check, as you chose")
        if other:
            why = {"it gives only a weak version": "since it gives only weak versions",
                   "it gave no version": "since it gave no version for that event"}
            said.append(" and ".join(provider_name(x) for x in other) + " was changed without the calendar's "
                        "version check, " + why.get(sent[other[0]], "since it can't take one"))
        return ("<i>Unprotected: " + "; ".join(said) + ". It was read and compared just before writing, but an "
                "edit made at the same time by someone else could have been overwritten or deleted.</i>")

    def _weak_fence(self, db, providers: list[str]) -> None:
        """Ninth round: refusals on unchanged events after an override, counted per calendar; at the first
        one there, a plain message that edits there can't be applied safely, naming the likely cause."""
        gate = card_gate(self.ledger)
        if not gate:
            return
        counts = gate.setdefault("override_refused", {})
        told = gate.setdefault("override_told", {})
        tell = []
        for provider in dict.fromkeys(providers):
            counts[provider] = int(counts.get(provider) or 0) + providers.count(provider)
            if not told.get(provider):
                told[provider] = iso(self.ledger.now())
                tell.append(provider)
        self.ledger.set_meta(CARD_GATE, json.dumps(gate), db)
        self.ledger.event("calendar_override_fence_refused", {"counts": counts}, db=db)
        for provider in tell:
            name = provider_name(provider)
            log.warning("%s refused the safety check on an unchanged event after its cards were opened without the "
                        "check: no more Try again there", provider)
            self._say(db, self.chat_id, None,
                      f"<b>Edits on {name} can't be applied safely.</b> Since {name} cards were opened without the "
                      f"check after installing, {name} has turned down a change at its safety check although the "
                      "event hadn't changed. The likely cause is that it gives a weak or rewritten version (etag) "
                      "for its events, so its safety check can't tell an unchanged event from a changed one. No "
                      f"retry button is offered on {name} from now on; a change there that's turned down this way "
                      "needs making in the calendar app itself.")

    def _schedule_reads(self, plan: dict, parts: list[int]) -> None:
        """A change not confirmed, or whose lease ran out: read again about 30 seconds and 2 minutes on,
        then once more after the long window (late_read_s), the last by id (0.24.0, fifth round)."""
        base = self.ledger.now()
        plan["recheck"] = [iso(base + timedelta(seconds=x)) for x in (*RECHECK_S, late_read_s(self.ledger))]
        plan["unverified"] = parts
        plan.pop("told_not_yet", None)

    def _recheck_unverified(self) -> None:
        """Changes kept as not confirmed, and changes whose lease ran out, read again in the background
        (0.24.0, fourth and fifth rounds): about 30 seconds and 2 minutes on, then after the long
        window, by the event's id where the calendar can. A read that shows each part as asked confirms
        it: "Confirmed." for one not confirmed, "Done after all" with Undo for one that lapsed. Not seen
        by 2 minutes is said once as not seen yet, to be read for again; not seen by the long window is
        said once as not found, and its event ids are still read for, every 30 minutes for a week, so a
        later appearance is Done after all with Undo. A read that can't tell waits for the next. Nothing
        is written either way, and all of it is in the ledger, so a restart goes on where it was."""
        now = self.ledger.now()
        for row in self.ledger.db.execute(
                "SELECT * FROM calendar_changes WHERE state IN ('unverified','lapsed','absent')").fetchall():
            plan = _plan(row)
            due = plan.get("recheck") or []
            watch = plan.get("watch_next")
            if due and datetime.fromisoformat(due[0]) <= now:
                self._follow_up(row, plan, due, now)
            elif not due and watch and datetime.fromisoformat(watch) <= now:
                self._watch(row, plan, now)

    def _parts_followed(self, plan: dict) -> list[dict]:
        return [plan["parts"][i] for i in plan.get("unverified", []) if i < len(plan.get("parts", []))]

    def _follow_up(self, row, plan: dict, due: list[str], now: datetime) -> None:
        pid = row["proposal_id"]
        parts = self._parts_followed(plan)
        last = len(due) == 1
        verdict = (self._by_id_done(parts) if last else self._reads_done(parts)) if parts else "unread"
        rest = due[1:]
        log.info("calendar change %s: %s, read again%s: %s", render.short(pid), row["state"],
                 " by id" if last else "", verdict)
        plan["recheck"] = rest
        if verdict == "done":
            plan.pop("recheck", None)
            if row["state"] == "unverified":
                self._confirmed(row, plan, parts)
            else:
                self._done_after_all(pid, plan, self._sent_entries(plan, row))
            return
        with self.ledger.tx() as db:
            if not rest and verdict == "not_done":
                plan["watch_next"] = iso(now + WATCH_EVERY)
                plan["watch_until"] = iso(now + WATCH_FOR)
                if row["state"] == "unverified":
                    db.execute("UPDATE calendar_changes SET state='absent', settle_json=?, updated_at=? WHERE"
                               " proposal_id=? AND state='unverified'", (json.dumps(plan), iso(now), pid))
                    self.ledger.event("calendar_change_absent", {"proposal": pid}, db=db)
                    undo = row["undo_state"] == "open"
                    buttons, binds = self._undo_button(db, pid) if undo else (None, None)
                    minutes = max(1, round(late_read_s(self.ledger) / 60))
                    self._say(db, self.chat_id, row["job_id"], "<b>Not found:</b> " + "; ".join(
                        part["will"] for part in parts) + f". Reads over {minutes} minutes, the last by its own "
                        "id, don't show it on the calendar, so nothing more is said about it and nothing is "
                        "written again. Its event id is kept: if it shows up later, you'll hear."
                        + (" Undo puts back what did go through." if undo else ""), buttons=buttons, binds=binds)
                else:
                    self._save_plan(pid, plan, db)     # lapsed: its card offered again is what he sees
                return
            if row["state"] == "unverified" and len(rest) == 1 and verdict == "not_done" \
                    and not plan.get("told_not_yet"):
                # Not "not done" (fifth round): not seen yet, and read for again.
                plan["told_not_yet"] = iso(now)
                minutes = max(1, round((datetime.fromisoformat(rest[0]) - now).total_seconds() / 60))
                self._say(db, self.chat_id, row["job_id"], "<b>Not seen yet:</b> " + "; ".join(
                    part["will"] for part in parts) + ". A read two minutes on doesn't show it yet, so I'll read "
                    f"the calendar for it again in about {minutes} minutes. Nothing is written again.")
            self._save_plan(pid, plan, db)

    def _confirmed(self, row, plan: dict, parts: list[dict]) -> None:
        now = self.ledger.now()
        plan["listed_at"] = iso(now)
        with self.ledger.tx() as db:
            db.execute("UPDATE calendar_changes SET state='done', settle_json=?, updated_at=? WHERE"
                       " proposal_id=? AND state='unverified'", (json.dumps(plan), iso(now), row["proposal_id"]))
            db.execute("UPDATE proposals SET state='executed' WHERE id=? AND state='failed'",
                       (row["proposal_id"],))
            db.execute("DELETE FROM meta WHERE key=?", (PROBLEM,))
            self.ledger.event("calendar_change_confirmed_later", {"proposal": row["proposal_id"]}, db=db)
            self._say(db, self.chat_id, row["job_id"], "<b>Confirmed.</b> A later read of the calendar "
                      "shows it as asked: " + "; ".join(part["will"] for part in parts) + ".")

    def _watch(self, row, plan: dict, now: datetime) -> None:
        """A change said as not found, or whose lease ran out, still read for by its event ids, every 30
        minutes for a week (fifth round). One that shows up is Done after all, with Undo. One a newer
        card already did is left to that card."""
        pid = row["proposal_id"]
        newer = self.ledger.get_meta(f"calendar_change_reoffer:{pid}")
        if newer:
            st = self.ledger.db.execute("SELECT state FROM proposals WHERE id=?", (newer,)).fetchone()
            if st is not None and st["state"] in ("approved", "auto_approved", "executing", "executed"):
                plan.pop("watch_next", None)
                self._save_plan(pid, plan)
                return
        verdict = self._by_id_done(self._parts_followed(plan))
        if verdict == "done":
            plan.pop("watch_next", None)
            self._done_after_all(pid, plan, self._sent_entries(plan, row))
            return
        until = plan.get("watch_until")
        plan["watch_next"] = iso(now + WATCH_EVERY) if not until or datetime.fromisoformat(until) > now else None
        if not plan["watch_next"]:
            plan.pop("watch_next")
        self._save_plan(pid, plan)

    @staticmethod
    def _sent_entries(plan: dict, row) -> list[dict]:
        """What Undo puts back of a change the calendar now shows: what it recorded as landed, and every
        write it sent and never heard back from."""
        undo = json.loads(row["undo_json"] or "[]")
        for part in plan.get("parts", []):
            for rec in part.get("steps", []):
                e = rec.get("entry")
                if e and rec.get("status") in ("landed", "trying", "unsure") and e not in undo:
                    undo.append(e)
        return undo

    def _by_id_done(self, parts: list[dict]) -> str:
        """The long window's read (fifth round): each part read by its event's id where the calendar can
        (an add at its fixed id, a moved event by its id, a removed one by its id), not a list; a series
        ended is read the usual way. "done", "not_done" or "unread"."""
        if not parts:
            return "unread"
        unread = False
        for part in parts:
            if part.get("already"):
                continue
            for e in part.get("expect") or []:
                got = self._one_by_id(e)
                if got == "unread":
                    unread = True
                elif got == "not_done":
                    return "not_done"
        return "unread" if unread else "done"

    def _one_by_id(self, e: dict) -> str:
        kind = e.get("kind")
        try:
            if kind == "there":
                same = self._by_id(e, whole=True, recurring=e.get("repeats") if "repeats" in e else None)
                return "done" if same == "same" else "not_done"
            if kind == "ended":
                return {"done": "done", "not_done": "not_done"}.get(self._reads_done([{"expect": [e]}]), "unread")
            ident = e.get("instance") if e.get("calendar") == "gmail" else e.get("id")
            if e.get("calendar") == "gmail":
                got, ev = self.google.look(self._gmail_address(), ident or e.get("series", ""))
                if got not in ("ok", "gone"):
                    return "unread"
                gone = got == "gone" or (ev or {}).get("status") == "cancelled"
                if kind == "gone":
                    return "done" if gone else "not_done"
                if gone:
                    return "not_done"
                start, end = self._gmail_when(ev.get("start")), self._gmail_when(ev.get("end"))
            else:
                href = self.client.href_for(caldav.href_path(ident or "").rsplit("/", 1)[-1].removesuffix(".ics"))
                out, body = self.client.fetch(href)
                if out.kind not in ("ok", "gone"):
                    return "unread"
                if kind == "gone":
                    if out.kind == "gone":
                        return "done"
                    day = self._day_of(e)
                    occs = self._occurrences(body, *self._bounds([day]))
                    return "not_done" if any(o.instance == e.get("instance", "") for o in occs) else "done"
                if out.kind == "gone":
                    return "not_done"
                want = _when(e["start"])
                day = self._day_of(e)
                occs = [o for o in self._occurrences(body, *self._bounds([day])) if o.instance == e.get("instance", "")]
                if not occs:
                    return "not_done"
                start, end = occs[0].start, occs[0].end
            want_end = _when(e["end"]) if e.get("end") else None
            return "done" if _same_start(start, _when(e["start"])) and (want_end is None or _same_start(end, want_end)) \
                else "not_done"
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, IndexError, ical.Unreadable):
            return "unread"

    def _newer_after_write(self, p) -> list[str]:
        """A no-tap change, just written: the DM read again at once (0.24.0, fourth round). His
        messages since the one recorded with its claim, or none."""
        seen = self.ledger.get_meta(f"calendar_change_fast_seen:{p['id']}")
        if not seen or self.after_fast is None or self.ledger.get_meta(f"calendar_change_fast_read:{p['id']}"):
            return []
        try:
            newer = self.after_fast(p, "" if seen == "-" else seen) or []
        except Exception as e:                  # a read that fails is logged, never a pass or a stop
            log.warning("after a no-tap change, the DM read failed: %s", type(e).__name__)
            newer = []
        with self.ledger.tx() as db:
            self.ledger.set_meta(f"calendar_change_fast_read:{p['id']}", iso(self.ledger.now()), db)
        if newer:
            log.info("calendar change %s: %d message(s) came in during its write: read as a correction",
                     render.short(p["id"]), len(newer))
        return newer

    def _read_as(self, p) -> list[str]:
        """Each day his own words named by a relative word, as it was read (provenance.resolutions),
        counted from the day he sent it in his time zone."""
        try:
            job = self.ledger.job(p["job_id"])
            root = self.ledger.get_meta(f"job_parent:{p['job_id']}") or p["job_id"]
            origin = json.loads(self.ledger.get_meta(f"job_origin:{root}") or "{}")
            sent = datetime.fromisoformat(origin.get("sent_at") or job["created_at"])
            his = self.ledger.job_text(p["job_id"]).split("\n\n[A suggestion from Cain", 1)[0]
            return provenance.resolutions(json.loads(p["params_json"])["changes"], his, self.tz, sent)
        except (ValueError, KeyError, TypeError, AttributeError):
            return []

    def _read_back(self, results: list, notes: list[str]) -> tuple[list, list[str]]:
        """Before any change is called done, the days it touched are read again, the way he'd see
        them (0.24.0, third round): an add must be there on its calendar with its title and time, a
        move at its new time and not its old one, a removal's very events (by calendar and id)
        gone, and a series ended with no day of it from then on. A read that disagrees is read once
        more a few seconds later, asking past any cache, and both reads are logged. If the calendar
        still doesn't show it, it isn't done: the receipt says what the calendar shows, the record
        keeps it as unverified, and nothing is written again on its own (what landed keeps its
        Undo). Another event like a removed one still in that slot is named too, so "took off" never
        hides one that stayed (Nov 15)."""
        out = []
        for part, landed, s, at in results:
            if s is not None or not part.expect:
                out.append((part, landed, s, at))
                continue
            problems, others, unread = self._check_part(part)
            if problems or unread:
                said = "; ".join(problems + [f"a read of {u} afterward didn't answer, so I can't confirm it"
                                             for u in unread])
                head = "I took it off" if part.bound and all(e["kind"] == "gone" for e in part.expect) \
                    else "I wrote it"
                out.append((part, landed, Stopped("read_back", words=(
                    f"Not confirmed: {part.will}. {head}, but {said}.")), landed[-1] if landed else None))
                continue
            out.append((part, landed, s, at))
            for cal, f in others:
                where = "Family" if cal == "family" else "Gmail"
                notes.append(f"Another {block_name(f.title) if f.block else f.title} at that time is still "
                             f"on your {where} calendar; I didn't touch it.")
        return out, notes

    def _check_part(self, part: Part) -> tuple[list[str], list[tuple[str, Found]], list[str]]:
        """(what the calendar shows that isn't what the part was for, other events like a removed
        one still at its time, calendars that couldn't be read)."""
        problems: list[str] = []
        others: list[tuple[str, Found]] = []
        unread: list[str] = []
        for cal in sorted({e["calendar"] for e in part.expect}):
            mine = [e for e in part.expect if e["calendar"] == cal]
            days, ahead = set(), timedelta(0)
            for e in mine:
                if e["kind"] == "ended":
                    days.add(date.fromisoformat(e["day"]))
                    ahead = timedelta(days=READ_BACK_DAYS)
                    continue
                days.add(self._day_of(e))
                if e.get("was"):
                    days.add(self._day_of({"start": e["was"]}))
            where = "Family" if cal == "family" else "your Gmail calendar"
            found = None
            for fresh in (False, True):
                if fresh:
                    self.sleep(READ_BACK_PAUSE_S)
                try:
                    found, _ = self._read(cal, sorted(days), ahead, fresh=fresh)
                except Refuse:
                    found = None
                    log.info("read back of %s (%s): no answer", cal, "fresh" if fresh else "first")
                    continue
                log.info("read back of %s (%s): %s", cal, "fresh" if fresh else "first",
                         "; ".join(f"{f.instance or f.series}|{_text(f.start) if f.start is not None else ''}|"
                                   f"{render.plain(f.title)[:40]}" for f in found)[:900] or "nothing")
                said = [w for e in mine for w in [self._shows(e, found, where)] if w]
                if not said:
                    break
            if found is None:
                unread.append(where)
                continue
            problems += said
            for e in mine:
                if e["kind"] == "gone":
                    t = _when(e["start"]) if e.get("start") else None
                    for f in found:
                        if (f.series, f.instance) != (e["series"], e["instance"]) and t is not None \
                                and _same_start(f.start, t) and any(
                                    fit(part.name, n) or fit(n, part.name) for n in (f.title, block_name(f.title))) \
                                and not any(f is o for _, o in others):
                            others.append((cal, f))
        return list(dict.fromkeys(problems)), others, unread

    def _by_id(self, e: dict, *, whole: bool = False, recurring: bool | None = None) -> str:
        """An add the day's read doesn't show, looked up by its own id: "“Dentist (bring forms)” at
        1:00 PM to 2:00 PM Sat Nov 21" when it's there under another time or name, "same" when
        it's there as asked, "" when it isn't there. `whole` (0.24.0, fifth round): "same" only when
        its end and, given `recurring`, whether it repeats match too; its start's kind (a time or a
        day) already tells all day from timed."""
        try:
            if e["calendar"] == "gmail":
                kind, ev = self.google.look(self._gmail_address(), e["id"])
                if kind != "ok" or not ev or ev.get("status") == "cancelled":
                    return ""
                title, start, end = ev.get("summary", ""), self._gmail_when(ev.get("start")), \
                    self._gmail_when(ev.get("end"))
                repeats = bool(ev.get("recurrence") or ev.get("recurringEventId"))
            else:
                out, body = self.client.fetch(self.client.href_for(e["id"]))
                if out.kind != "ok":
                    return ""
                today = self._today()
                occs = self._occurrences(body, *self._bounds([today - timedelta(days=1), today + timedelta(days=400)]))
                if not occs:
                    return ""
                title, start, end = occs[0].summary, occs[0].start, occs[0].end
                repeats = "RRULE" in body.upper()
            if start is None or end is None:
                return ""
            if _same_start(start, _when(e["start"])) and exact_title(title) == exact_title(e["title"]) \
                    and (not whole or ((not e.get("end") or _same_start(end, _when(e["end"])))
                                       and (recurring is None or repeats == recurring))):
                return "same"
            return f"\u201c{_safe(title)}\u201d at {self._at_words(start, end)}"
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, IndexError, ical.Unreadable):
            return ""

    def _shows(self, e: dict, found: list[Found], where: str) -> str:
        """"" when the read shows what this expectation is for; else what it shows, in words."""
        kind = e["kind"]
        if kind == "gone":
            if any((f.series, f.instance) == (e["series"], e["instance"]) for f in found):
                return f"a read of {where} still shows it there"
            return ""
        if kind == "ended":
            day = date.fromisoformat(e["day"])
            left = sorted(f.first for f in found if f.series == e["series"] and f.first >= day)
            return f"a read of {where} still shows {_safe(e['title'])} on {_day_words(left[0])}" if left else ""
        start, end = _when(e["start"]), _when(e["end"]) if e.get("end") else None
        if kind == "there":
            mine = [f for f in found if e["id"] in (f.series, f.instance)]
            if any(_same_start(f.start, start) and exact_title(f.title) == exact_title(e["title"]) for f in mine):
                return ""
            if mine:
                f = mine[0]
                return (f"a read of {where} shows \u201c{_safe(f.title)}\u201d at "
                        f"{self._at_words(f.start, f.end)} instead")
            elsewhere = self._by_id(e)
            if elsewhere == "same":
                return f"a read of {where} for that day doesn't list it, though it's there by its own id"
            if elsewhere:
                return f"a read of {where} shows it as {elsewhere} instead"
            near = [f for f in found if _same_start(f.start, start)]
            if near:
                return (f"a read of {where} doesn't show it at that time; it shows "
                        + ", ".join(f"\u201c{_safe(f.title)}\u201d" for f in near[:3]))
            return f"a read of {where} doesn't show it on that day"
        # moved
        mine = [f for f in found if (f.series, f.instance) == (e["series"], e["instance"])]
        if any(_same_start(f.start, start) and (end is None or f.end is None or _same_start(f.end, end))
               for f in mine):
            return ""
        was = _when(e["was"]) if e.get("was") else None
        if any(was is not None and _same_start(f.start, was) for f in mine):
            return f"a read of {where} still shows it at the old time, {self._at_words(was, mine[0].end)}"
        if mine:
            return f"a read of {where} shows it at {self._at_words(mine[0].start, mine[0].end)}"
        return f"a read of {where} shows it at neither the old time nor the new one"

    def _day_of(self, b: dict) -> date:
        when = _when(b["start"])
        return when.astimezone(ZoneInfo(self.tz)).date() if isinstance(when, datetime) else when

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

    def _read(self, calendar: str, days: list[date], ahead: timedelta = timedelta(0), *,
              fresh: bool = False) -> tuple[list[Found], int]:
        """`fresh`: asking past any cache (a read back read once more)."""
        start, end = self._bounds(days, ahead)
        extra = {"fresh": True} if fresh else {}
        if calendar == "family":
            read = self.client.items_between(start, end, self.tz, **extra)
            if read is None:
                raise Refuse("I couldn't read the Family calendar")
            out = []
            for item in read.items:
                occ = item.occ
                out.append(Found(occ.uid, occ.instance, occ.summary, *self._span(occ.start, occ.end),
                                 bool(occ.instance), occ.start, item, bool(occ.attendees), "family", occ.end))
            return out, read.unreadable
        events = self.google.events_between(self._gmail_address(), start, end, **extra)
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
            return [self._add_part(c, key, force=self._forcing)], []
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
        if _same_start(hit.start, start) and hit.end is not None and _same_start(hit.end, end) \
                and all(_same_start(x.start, start) for x in hit.copies):
            # Already at that time (0.24.0, fourth round): the current time is checked again at the
            # apply, so a move that landed already (late, or before a card offering it again was
            # tapped) is a no-op, never a second write.
            name = self._name(c["title"], hit)
            words = (f"Already at that time, nothing moved: \u201c{_safe(hit.title)}\u201d, "
                     f"{self._when_words(start, end)}{self._where(hit, bool(hit.copies))}")
            return [Part(words, words, [], name=name, already=words, bound=self._bound_of(hit, "move"))], []
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
        # Bound to the event the read found, by calendar and id, as a removal is (0.24.0, third
        # round), and read back at its new time before Done.
        bound = self._bound_of(hit, "move")
        expect = [{"kind": "moved", "calendar": b["calendar"], "series": b["series"], "instance": b["instance"],
                   "title": b["title"], "start": _text(start), "end": _text(end), "was": b["start"]}
                  for b in bound]
        part = Part(will, done, steps, (targets, ("move", _moment(start), _moment(end))), name=name,
                    bound=bound, expect=expect)
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
            bound = self._bound_of(f)
            parts.append((f.first, Part(will, done, steps, (targets, ("remove",)), removes=1,
                                        name=self._name(asked, f), bound=bound,
                                        expect=[{"kind": "gone", **b} for b in bound])))
        for group in series.values():
            will, done = self._remove_words(self._name(asked, group[0]), group, [g.first for g in group],
                                            " (Family)")
            targets = frozenset(("family", g.series, g.instance) for g in group)
            bound = [b for g in group for b in self._bound_of(g)]
            parts.append((min(g.first for g in group),
                          Part(will, done, [self._family_remove_days(group)], (targets, ("remove",)),
                               removes=len(group), name=self._name(asked, group[0]), bound=bound,
                               expect=[{"kind": "gone", **b} for b in bound])))
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
        # The whole series from that day on: bound by its id, with that scope on the card, and read
        # back as ended (no day of it on or after then) before Done.
        bound = [{"calendar": f.calendar, "series": f.series, "instance": "", "id": f.series, "title": f.title,
                  "start": "", "op": "end", "recurrence": "", "scope": "series"}
                 for f in series.values()]
        expect = [{"kind": "ended", "calendar": f.calendar, "series": f.series, "day": day.isoformat(),
                   "title": f.title} for f in series.values()]
        return [Part(f"End {text}", f"Ended {text}", steps, (targets, ("end", day.isoformat())),
                     ends=name, name=name, warns=[fact] if fact else [], bound=bound, expect=expect)], \
            [fact[0].upper() + fact[1:]] if fact else []

    # -- a tap's effect, read by its own identity (sixteenth round) -----------------------------------------------
    LANDED = ("done", "removed")

    def tap_effect(self, op: dict) -> str:
        """For a tap whose outcome isn't known (the records put back from a backup, or an error after its intent):
        whether the calendar shows what it led to, read by the effect's own stable identity and never by a search
        of the slot (tap_parts). "done" when every part reads as done; "removed" (seventeenth round) when every part
        landed and one has since been taken off the calendar (a Google event read as cancelled at its fixed id):
        nothing is done again; "mixed" when some parts landed and others didn't (Go ahead runs only the others);
        else "not_done" when a read answered that a part isn't there, "unread" when a read couldn't tell,
        "unchecked" when a part carries no identity to read by."""
        if (op or {}).get("effect") == "undo":
            return self.combine(self.undo_parts(op))
        return self.combine(self.tap_parts(op))

    @classmethod
    def combine(cls, got: list[str]) -> str:
        if not got:
            return "unchecked"
        if all(v in cls.LANDED for v in got):
            return "removed" if "removed" in got else "done"
        if any(v in cls.LANDED for v in got):
            return "mixed"
        for verdict in ("not_done", "unread", "unchecked"):
            if verdict in got:
                return verdict
        return "unread"

    def tap_parts(self, op: dict) -> list[str]:
        """Seventeenth round: the read of tap_effect, one verdict per change in `op` (in order): an add (or a
        repeating add) by the fixed id it's written under (from the key in `op`): "done" there, "removed" read as
        cancelled there (it was added and has since been deleted), "not_done" not there; a Gmail removal by the event
        id the card was bound to ("done" when that event is gone or cancelled); "unread"; "unchecked" for a change
        that carries no identity to read by."""
        changes = list((op or {}).get("changes") or [])
        pid = str((op or {}).get("proposal") or "")
        keys = [str(k) for k in (op or {}).get("keys") or []]
        bound = [b for b in (op or {}).get("bound") or [] if isinstance(b, dict)]
        got = []
        for i, c in enumerate(changes):
            kind, calendar = c.get("op"), c.get("calendar")
            if kind in ("add", "add_series"):
                key = keys[i] if i < len(keys) else f"{pid}:{i}"
                got.append(self._there_by_id(calendar, self._uid(key, "hm-" if calendar == "family" else "cm")))
            elif kind == "remove" and calendar == "gmail":
                mine = [b for b in bound if b.get("op") == "remove" and b.get("calendar") == "gmail"
                        and (b.get("change") in (None, i))]
                if not mine:
                    got.append("unchecked")
                    continue
                each = [self._there_by_id("gmail", str(b.get("instance") or b.get("id") or "")) for b in mine]
                each = [{"done": "not_done", "not_done": "done", "removed": "done"}.get(x, x) for x in each]
                got.append("done" if all(x == "done" for x in each) else
                           next(v for v in ("not_done", "unread") if v in each))
            else:
                got.append("unchecked")
        return got

    def _there_by_id(self, calendar: str, ident: str) -> str:
        """One event read by its id: "done" (there, not cancelled), "removed" (a Google event read as cancelled:
        it was there and has been deleted since), "not_done" (no such event), "unread"."""
        if not ident:
            return "unread"
        if calendar == "gmail":
            if self.google is None or not self.address():
                return "unread"
            kind, ev = self.google.look(self._gmail_address(), ident)
            if kind == "ok" and (ev or {}).get("status") == "cancelled":
                return "removed"
            if kind == "gone":
                return "not_done"
            return "done" if kind == "ok" and ev else "unread"
        out, _ = self.client.fetch(self.client.href_for(ident))
        return {"ok": "done", "gone": "not_done"}.get(out.kind, "unread")

    # -- a choice tap's readable identity (seventeenth round) --------------------------------------------------
    def add_anyway_op(self, proposal_id: str) -> dict | None:
        """His Add anyway, named by a stable identity before it's acted on: the adds it makes and the keys their
        fixed ids are made from. The keys come from the receipt's own proposal (add_anyway_key), not from the new
        proposal it creates, so the same tap taken again (Go ahead after the records were put back, where its
        nonce reads unused) writes to the very same ids and finds the first write."""
        row = self.ledger.db.execute("SELECT settle_json FROM calendar_changes WHERE proposal_id=?",
                                     (proposal_id,)).fetchone()
        if row is None:
            return None
        changes = [part["change"] for part in _plan(row).get("parts", []) if part.get("already") and part.get("change")]
        if not changes:
            return None
        return {"effect": effects.CALENDAR_CHANGE, "kind": "calendar_change_add_anyway", "proposal": "",
                "changes": changes, "keys": [add_anyway_key(proposal_id, i) for i in range(len(changes))],
                "bound": []}

    def undo_op(self, target: str) -> dict | None:
        """His Undo, named by a stable identity before it's acted on: each event it puts back (its id or address)
        and the state it must read in afterwards (gone; there again; or its version from before the change), from
        the first step this change made on it. None when there's nothing open to undo."""
        steps, seen = [], set()
        for pid in str(target or "").split():
            row = self.ledger.db.execute("SELECT undo_json, undo_state FROM calendar_changes WHERE proposal_id=?",
                                         (pid,)).fetchone()
            if row is None or row["undo_state"] != "open":
                continue
            try:
                undo = json.loads(row["undo_json"] or "[]")
            except ValueError:
                undo = []
            for st in undo if isinstance(undo, list) else []:
                if not isinstance(st, dict):
                    continue
                if st.get("cal") not in ("gmail", "family"):
                    steps.append({"cal": str(st.get("cal") or "")})
                    continue
                key = self._object_key(st)
                if key in seen:
                    continue                    # the first step on an event is what Undo puts it back to
                seen.add(key)
                if st["cal"] == "gmail":
                    steps.append({"cal": "gmail", "how": st.get("how", ""), "id": st.get("id", ""),
                                  "fields": st.get("fields") or {}})
                else:
                    steps.append({"cal": "family", "how": st.get("how", ""), "href": st.get("href", ""),
                                  "before": st.get("before", "")})
        if not steps:
            return None
        return {"effect": "undo", "kind": "calendar_change_undo", "steps": steps}

    def undo_parts(self, op: dict) -> list[str]:
        """The read of an Undo's identity, one verdict per event: "done" when it reads as Undo leaves it, "not_done"
        when a read answered that it doesn't, "removed" when the event was deleted since (an edit's undo), "unread",
        "unchecked" for a step with nothing to read (a Family rule)."""
        got = []
        for st in (op or {}).get("steps") or []:
            how = st.get("how")
            try:
                if st.get("cal") == "gmail":
                    if self.google is None or not self.address():
                        got.append("unread")
                        continue
                    kind, cur = self.google.look(self._gmail_address(), str(st.get("id") or ""))
                    if kind == "unknown":
                        got.append("unread")
                        continue
                    cancelled = kind == "gone" or (cur or {}).get("status") == "cancelled"
                    if how == "drop":
                        got.append("done" if cancelled else "not_done")
                    elif how == "restore":
                        got.append("not_done" if cancelled else "done")
                    elif cancelled:
                        got.append("removed")
                    else:
                        got.append("done" if self._as_written(cur, st.get("fields") or {}) else "not_done")
                elif st.get("cal") == "family":
                    out, body = self.client.fetch(str(st.get("href") or ""))
                    if out.kind not in ("ok", "gone"):
                        got.append("unread")
                    elif how == "delete":
                        got.append("done" if out.kind == "gone" else "not_done")
                    elif out.kind == "gone":
                        got.append("not_done" if how == "restore" else "removed")
                    else:
                        got.append("done" if caldav._unchanged(body, st.get("before") or "") else "not_done")
                else:
                    got.append("unchecked")
            except (KeyError, TypeError, ValueError, AttributeError):
                got.append("unread")
        return got

    def skip_found(self, pid: str, indexes: list[int]) -> None:
        """Seventeenth round: his Go ahead on a change some of whose parts the calendar already shows: those parts
        are left out when it runs (_plan_all), so only what isn't there is done."""
        with self.ledger.tx() as db:
            self.ledger.set_meta(f"calendar_change_skip:{pid}", json.dumps(sorted(set(int(i) for i in indexes))), db)

    def _skipped(self, pid: str) -> set[int]:
        try:
            got = json.loads(self.ledger.get_meta(f"calendar_change_skip:{pid}") or "[]")
            return {int(i) for i in got} if isinstance(got, list) else set()
        except (ValueError, TypeError):
            return set()

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

    def _add_part(self, c: dict, key: str, force: bool = False) -> Part:
        start, end, rule = self._new_times(c)
        loose = ""
        uid = self._uid(key, "hm-" if c["calendar"] == "family" else "cm")
        if force:
            # Seventeenth round: an Add anyway writes no check for "already there", but it reads its own fixed id
            # first: a write of this very tap that landed is found and kept, and one deleted since isn't put back.
            text = f"{_safe(c['title'])}{self._new_words(c, start, end)}"
            where = " (Family)" if c["calendar"] == "family" else " (Gmail)"
            there = self._there_by_id(c["calendar"], uid)
            if there == "done":
                expect = [{"kind": "there", "calendar": c["calendar"], "id": uid, "title": c["title"],
                           "start": _text(start), "end": _text(end), "repeats": bool(rule)}]
                return Part(f"Add {text}{where}", f"On the calendar: {text}{where}", [], name=_safe(c["title"]),
                            adds=True, expect=expect, change=dict(c))
            if there == "removed":
                raise Refuse(f"\u201c{render.plain(c['title'])}\u201d was added as a second event before and has since "
                             f"been taken off your calendar, so it isn't added again")
        if c["op"] == "add" and not force:
            # Its own fixed id first (0.24.0, fourth round): a change offered again after its lease
            # ran out keeps the id of the first offer, so an earlier write that landed late is found
            # here, by that id, and isn't written a second time.
            same, like = self._made_already(c, uid, start, end), None
            for twin in ([] if same is not None else self._unsettled_ids(c, start, end)):
                # A retry of a change kept as not confirmed (or lapsed) passes the same decision
                # first, against that change's own id: its write may be there after all.
                same = self._made_already(c, twin, start, end)
                if same is not None:
                    break
            if same is None:
                same, like = self._already_there(c, start, end, rule)
            if same is None:
                # Seventh round: an add of ours read back within the listing lag the smoke run measured may
                # not show in the listing yet: each such add of the same event is read by its own id.
                for twin in self._recent_own_adds(c, start, end):
                    same = self._made_already(c, twin, start, end)
                    if same is not None:
                        like = None
                        break
            if same is not None:
                # Nov 15: an add into a slot that held a drop-off block was recorded as done, and the
                # removal after it reported the block gone while it stayed. Only the very same event
                # (this calendar, the same title, start and end, all day or not, repeating or not) is
                # "already there": nothing is written, nothing is recorded as made, and it's never
                # silent (0.24.0, fourth round): the receipt names the event that's there, with Add
                # anyway.
                cal = "Family" if same.calendar == "family" else "Gmail"
                words = (f"Already there, nothing added: \u201c{_safe(same.title)}\u201d, "
                         f"{self._when_words(same.start, same.end) if same.end is not None else _day_words(same.first)}, "
                         f"is on your {cal} calendar. Add anyway adds a second one")
                return Part(words, words, [], name=_safe(c["title"]), already=words, change=dict(c),
                            created=self._created_of(same), found_id=same.series)
            if like is not None:
                # One only like it (one name holds the other's words, it's on the other calendar, or
                # its end, all-day or repeating differs): his decision, on a card that names it, and
                # nothing written until he taps.
                cal = "Family" if like.calendar == "family" else "Gmail"
                loose = (f"Already on your {cal} calendar at that time: \u201c{_safe(like.title)}\u201d, "
                         f"{self._when_words(like.start, like.end) if like.end is not None else _day_words(like.first)}"
                         f"{', repeating' if like.repeats else ''}. "
                         "Add anyway adds a second event; Leave it adds nothing.")
        orig = c
        if getattr(self, "_smoke_now", ""):
            # Seventh round: a smoke run's add is a test event: its title says so and it carries the run's
            # id as a private property, so what's left of the run is found and taken off (smoke_leftovers).
            c = {**c, "title": SMOKE_PREFIX + c["title"].removeprefix(SMOKE_PREFIX), "smoke": self._smoke_now,
                 "smoke_nonce": getattr(self, "_smoke_nonce", "")}
        step = (self._family_add if c["calendar"] == "family" else self._gmail_add)(c, key)
        text = f"{_safe(c['title'])}{self._new_words(c, start, end)}"
        where = " (Family)" if c["calendar"] == "family" else " (Gmail)"
        c, written = orig, c
        expect = [{"kind": "there", "calendar": c["calendar"], "id": uid, "title": written["title"],
                   "start": _text(start), "end": _text(end), "repeats": bool(rule)}]
        return Part(f"Add {text}{where}", f"Added {text}{where}", [step], name=_safe(c["title"]), adds=True,
                    expect=expect, loose=loose, change=dict(c))

    def _lag_rows(self) -> list:
        """Changes with a write read back within the measured listing lag (listing_lag_s) of now."""
        lag = listing_lag_s(self.ledger)
        if not lag:
            return []
        since = iso(self.ledger.now() - timedelta(seconds=lag))
        return self.ledger.db.execute("SELECT * FROM calendar_changes WHERE updated_at>=? AND state IN"
                                      " ('done','landed_late','settling','sending')", (since,)).fetchall()

    def _recent_own_adds(self, c: dict, start, end) -> list[str]:
        """Ids of our own adds of this very event (calendar, title, start, end) read back within the
        listing lag (seventh round)."""
        lag = listing_lag_s(self.ledger)
        out = []
        for row in self._lag_rows():
            for part in _plan(row).get("parts", []):
                for e in part.get("expect") or []:
                    recent = any(rec.get("back") and (self.ledger.now() - datetime.fromisoformat(rec["back"]))
                                 <= timedelta(seconds=lag) for rec in part.get("steps", []))
                    if recent and e.get("kind") == "there" and e.get("calendar") == c["calendar"] \
                            and exact_title(e.get("title", "")) == exact_title(c["title"]) \
                            and e.get("start") == _text(start) and e.get("end") == _text(end) and e.get("id"):
                        out.append(e["id"])
        return list(dict.fromkeys(out))

    def _recent_write_on(self, calendars: set[str]) -> int:
        """Seconds since a write of ours on one of these calendars was read back, when that's within the
        listing lag the smoke run measured (seventh round); 0 otherwise."""
        lag = listing_lag_s(self.ledger)
        best = 0
        for row in self._lag_rows():
            for part in _plan(row).get("parts", []):
                for rec in part.get("steps", []):
                    provider, _ = _STEP_FN.get((rec.get("spec") or {}).get("fn", ""), ("", ""))
                    if provider in calendars and rec.get("back"):
                        ago = (self.ledger.now() - datetime.fromisoformat(rec["back"])).total_seconds()
                        if 0 <= ago <= lag:
                            best = max(best, int(ago) or 1)
        return best

    def _created_of(self, f: Found) -> str:
        """When the calendar says this event was made: Google's "created", or the CREATED line of its
        iCloud resource (read by its address when the list didn't carry its text). "" when unknown."""
        try:
            if f.calendar == "gmail":
                when = datetime.fromisoformat(str((f.raw or {}).get("created") or "").replace("Z", "+00:00"))
                return when.astimezone(timezone.utc).isoformat()
            body = getattr(f.raw, "data", "") or ""
            if "CREATED" not in body.upper():
                out, body = self.client.fetch(f.raw.href)
                if out.kind != "ok":
                    return ""
            m = re.search(r"(?im)^CREATED[^:\r\n]*:(\d{8}T\d{6})Z?\s*$", body or "")
            if not m:
                return ""
            return datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).isoformat()
        except (ValueError, TypeError, AttributeError):
            return ""

    def _unsettled_ids(self, c: dict, start, end) -> list[str]:
        """The fixed ids of earlier adds of this very event (calendar, title, start, end) that were
        never confirmed: not confirmed, settled as absent, or lapsed, in the last week."""
        out = []
        since = iso(self.ledger.now() - timedelta(days=7))
        for row in self.ledger.db.execute(
                "SELECT settle_json FROM calendar_changes WHERE state IN ('unverified','absent','lapsed')"
                " AND updated_at>=? ORDER BY rowid DESC LIMIT 20", (since,)).fetchall():
            try:
                parts = json.loads(row[0] or "{}").get("parts") or []
            except ValueError:
                continue
            for part in parts:
                for e in part.get("expect") or []:
                    if e.get("kind") == "there" and e.get("calendar") == c["calendar"] \
                            and exact_title(e.get("title", "")) == exact_title(c["title"]) \
                            and e.get("start") == _text(start) and e.get("end") == _text(end):
                        out.append(e["id"])
        return list(dict.fromkeys(out))

    def _made_already(self, c: dict, uid: str, start, end) -> "Found | None":
        """The event this very add writes, found by its own fixed id, already there as asked: an
        earlier write of it that landed (late, or after its lease ran out). None when it isn't, or
        a read can't tell (then the slot is read as for any add)."""
        try:
            if c["calendar"] == "gmail":
                if self.google is None or not self.address():
                    return None
                kind, ev = self.google.look(self._gmail_address(), uid)
                if kind != "ok" or not ev or ev.get("status") == "cancelled":
                    return None
                first, last = self._gmail_when(ev.get("start")), self._gmail_when(ev.get("end"))
                if first is None or last is None:
                    return None
                f = Found(uid, uid, ev.get("summary", ""), *self._span(first, last), False, first, ev, False,
                          "gmail", last)
            else:
                out, body = self.client.fetch(self.client.href_for(uid))
                if out.kind != "ok":
                    return None
                today = self._today()
                occs = self._occurrences(body, *self._bounds([today - timedelta(days=1), today + timedelta(days=400)]))
                if not occs:
                    return None
                o = occs[0]
                f = Found(o.uid, o.instance, o.summary, *self._span(o.start, o.end), False, o.start, None, False,
                          "family", o.end)
        except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            return None
        if exact_title(f.title) == exact_title(c["title"]) and _same_start(f.start, start) \
                and _same_start(f.end, end):
            log.info("add %s: its own id is already on the calendar as asked", render.short(uid))
            return f
        return None

    def _already_there(self, c: dict, start, end=None, rule: str = "") -> "tuple[Found | None, Found | None]":
        """What's already in the slot an add asks for (0.24.0, third and fourth rounds): (the very
        same event: on the same calendar with the same title, normalised, at the same start, and
        with the same end, all day or timed alike, and repeating alike; or else one only like it:
        the same calendar, title and start with another end, all-day status or repetition, or at
        the same start on either calendar with one name holding the other's words, like "School
        drop-off" and Harness's "Busy (school drop-off)" block). An empty or very short title is
        never already there. A read that fails finds nothing, and the add goes as asked."""
        want = exact_title(c["title"])
        if len(want) < SHORT_TITLE:
            return None, None
        day = start.astimezone(ZoneInfo(self.tz)).date() if isinstance(start, datetime) else start
        try:
            first, rest, _, _ = self._pool(c["calendar"], [day])
        except Refuse:
            return None, None
        asked = c["title"]
        same = like = None
        for f in first + rest:
            timed = isinstance(start, datetime)
            if f.calendar == c["calendar"] and exact_title(f.title) == want and (
                    _same_start(f.start, start) if timed == isinstance(f.start, datetime)
                    else self._day_of({"start": _text(f.start)}) == day):
                exact = timed == isinstance(f.start, datetime) and (end is None or f.end is None
                                                                    or _same_start(f.end, end)) \
                    and bool(f.repeats) == bool(rule)
                if exact:
                    same = same or f
                else:
                    like = like or f                 # same name and start, not the same event
                continue
            if timed != isinstance(f.start, datetime) or not _same_start(f.start, start):
                continue
            names = {n for n in (f.title, block_name(f.title)) if len(exact_title(n)) >= SHORT_TITLE}
            if any(fit(asked, n) or fit(n, asked) for n in names):
                like = like or f
        return same, like

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
    def _family_fetch(self, href: str) -> "FamilyRead":
        """The read just before a Family write (seventh round): the resource's body and its version as
        one object, so the write's body and its If-Match always come from the same read (_family_write)."""
        out, body = self.client.fetch(href)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status)
        if not out.etag:
            raise Stopped("failed", out.status, "iCloud gave no version of that event to guard the change")
        return FamilyRead(href, body, out.etag)

    def unprotected_calendars(self, params: dict, bound: list | None = None) -> dict:
        """Twelfth round: the calendars this change writes to that go without If-Match, with why: "opened"
        (he opened it without protection) or "weak" (the check after installing found it gives only weak
        versions, so its writes go as a read-compare-write)."""
        out = {}
        try:
            cals = self.providers_of(params, bound)
        except (ValueError, KeyError, TypeError, AttributeError):
            cals = []
        for x in cals:
            if self._unprotected(x):
                out[x] = "opened"
            elif etag_strength(self.ledger, x) == "weak":
                out[x] = "weak"
        return out

    def unprotected_note(self, params: dict, bound: list | None = None) -> str:
        """The line an approval card carries for those calendars (twelfth round), or ""."""
        got = self.unprotected_calendars(params, bound)
        if not got:
            return ""
        names = " and ".join(provider_name(x) for x in got)
        return (f"<i>Unprotected: {names} is changed without the calendar's version check. It's read and compared "
                "with this card just before writing, but an edit made at the same time by someone else can be "
                "overwritten or deleted.</i>")

    def _unprotected(self, provider: str) -> bool:
        """Eleventh round: he opened this calendar without protection (Open without protection)."""
        return bool(((card_gate(self.ledger).get("override") or {}).get(provider) or {}).get("unprotected"))

    def _send_guard(self, calendar: str, guard: str | None) -> str | None:
        """The If-Match actually sent (eleventh round). Sent only when the calendar gave a strong version:
        a weak one never matches under If-Match's strong comparison, so where only a weak one exists, and on
        a calendar he opened without protection, the fence is a read-compare-write: the read just before the
        write was compared with the card (_card_etag, weakly), the compare is logged, and the write goes with
        no If-Match (None). Twelfth round: every write that goes without If-Match, for any reason (no version
        at all included), is marked on its step (rcw), so its receipt says Unprotected, the re-close rule
        leaves it be, and its read back is compared for a lost update (_check_lost)."""
        unprotected = self._unprotected(calendar)
        if guard and not (unprotected or _weak(guard)):
            return guard
        why = ("opened without protection" if unprotected else "it gives only a weak version" if guard
               else "it gave no version")
        log.info("%s: read-compare-write (%s): the read just before the write gave version %s and was compared "
                 "with the card's; sent without If-Match", calendar, why, guard or "none")
        self._rcw_seen.add(calendar)
        rec = self._recording
        if rec is not None:
            rec[2].update(rcw=True, rcw_cal=calendar, rcw_why=why, compared=guard or "", unprotected=unprotected)
        return None

    def _guard_for(self, read: "FamilyRead") -> str | None:
        """The If-Match a move or removal on Family sends (_card_etag): always the version of the read the
        write's body was built from (seventh round), or nothing is sent (eighth round: the event changed
        since the card, so the stale path instead)."""
        ident = caldav.href_path(read.href or "").rsplit("/", 1)[-1]
        body = read.body
        cache: dict = {}

        def print_of(b: dict):
            key = (b.get("instance"), b.get("start"))
            if key not in cache:
                try:
                    cache[key] = self._family_print(body, b["instance"], self._day_of(b))
                except (ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
                    cache[key] = None
            return cache[key]

        def same(b: dict) -> bool:
            got = print_of(b)
            return _print_same(got, b.get("print"))
        first = next(iter(self._card_bound("family", ident)), None)
        same.now = print_of(first) if first is not None else None
        same.shows = ""
        if same.now:
            try:
                start, end = _when(same.now["start"]), _when(same.now["end"])
                same.shows = f"\u201c{_safe(first.get('title', ''))}\u201d at {self._at_words(start, end)}"
            except (ValueError, KeyError, TypeError):
                pass
        guard = self._card_etag("family", ident, read.etag, same, self._shared("family", body))
        if guard != read.etag:
            raise Stopped("failed", words="the write's version didn't come from the read it was built from")
        return self._send_guard("family", guard)

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

    def _family_write(self, read: "FamilyRead", edit: Callable[[str], str], check: dict, title: str = "") -> dict:
        """The write, then what the calendar holds afterward, not what was sent. An answer that's
        lost, or a read back that fails or doesn't show it, leaves it to a read (_settle). Sent over
        the card's version when it kept one: a refusal for the version is read by id (_fenced).

        Seventh round: the body is the pre-write read's own body with only the requested change made
        (`edit`), so overrides, exception dates, attendees and every other day of a shared resource
        stay as that read has them, and the If-Match is that same read's version (_guard_for). No other
        version is ever sent: when the event changed since the card, nothing is (eighth round)."""
        href, before, etag = read.href, read.body, read.etag
        new = edit(before)
        entry = {"cal": "family", "how": "put", "href": href, "before": before, "after": new,
                 "sent": new, "etag": "", "was": etag, "check": check}
        guard = self._guard_for(read)            # stale since the card: nothing is sent (eighth round)
        self._attempt(entry)
        out = self._bounded("family", self.client.replace, href, guard, new)
        self._sent("family", check.get("kind") or "change", guard, out)
        if out.kind == "changed" and title:
            self._fenced("family", "", {"kind": check.get("kind"), "check": check}, title, href, guard)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status, undo=entry if out.kind == "unknown" else None)
        entry["etag"] = out.etag or ""
        back, body = self.client.fetch(href)
        if back.kind != "ok":
            raise Stopped("unknown", back.status, undo=entry)
        entry["etag"] = back.etag or entry["etag"]
        if guard and etag and back.etag and back.etag == etag and _ics_content(body) != _ics_content(before):
            # Eleventh round: only changed content under the same version; a no-op write keeping it never.
            # Twelfth round: and only a write that carried If-Match (_version_unmoved checks the calendar too).
            self._version_unmoved("family", self._write_words(entry, title))
        if not guard:
            self._check_lost("family", title, _ics_fields(before), _ics_fields(new), _ics_fields(body))
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
            read = self._family_fetch(href)
            return self._family_write(read, lambda body: ics_edit.remove_days(body, keys, self.tz, self.ledger.now()),
                                      check, first.title)
        return Step(f"Family: {_safe(first.title)} off {_list(days)}.", run,
                    [("family", first.series, k, first.title, d) for k, d in zip(keys, days)], what="Family",
                    spec={"fn": "family_remove_days", "found": [_found_json(f) for f in group]})

    def _family_delete(self, read: "FamilyRead", title: str = "") -> dict:
        href, body, etag = read.href, read.body, read.etag
        entry = {"cal": "family", "how": "restore", "href": href, "before": body, "was": etag}
        guard = self._guard_for(read)            # stale since the card: nothing is sent (eighth round)
        self._attempt(entry)
        out = self._bounded("family", self.client.remove_at, href, guard)
        self._sent("family", "removal", guard, out)
        if out.kind == "changed" and title:
            self._fenced("family", "", {"kind": "gone"}, title, href, guard)
        if out.kind != "ok":
            raise Stopped(out.kind, out.status, undo=entry if out.kind == "unknown" else None)
        back, _ = self.client.fetch(href)
        if back.kind != "gone":             # still there, or the read failed: a read settles it
            raise Stopped("unknown", back.status, undo=entry)
        return entry

    def _family_remove_one(self, f: Found) -> Step:
        def run() -> dict:
            read = self._family_fetch(f.raw.href)
            if ics_edit.people(read.body):
                raise ics_edit.Cant("it has invitees, and changing it could message them")
            return self._family_delete(read, f.title)
        return Step(f"Family: {_safe(f.title)} on {_day_words(f.first)} removed.", run,
                    [("family", f.series, "", f.title, f.first)], what="Family",
                    spec={"fn": "family_remove_one", "found": [_found_json(f)]})

    def _family_end(self, f: Found, day: date) -> Step:
        href = f.raw.href
        check = {"kind": "ends", "day": day.isoformat()}

        def run() -> dict:
            read = self._family_fetch(href)
            if ics_edit.end_from(read.body, day, self.tz, self.ledger.now()) is None:
                return self._family_delete(read, f.title)
            return self._family_write(read, lambda body: ics_edit.end_from(body, day, self.tz, self.ledger.now()),
                                      check, f.title)
        return Step(f"Family: {_safe(f.title)} ends, with nothing on or after {_day_words(day)}.", run,
                    [("family", f.series, "*", f.title, day)], what="Family",
                    spec={"fn": "family_end", "found": [_found_json(f)], "day": day.isoformat()})

    def _family_move(self, f: Found, start, end) -> Step:
        href = f.raw.href
        check = {"kind": "starts", "start": _text(start), "end": _text(end), "instance": f.instance,
                 "uid": f.series}

        def run() -> dict:
            read = self._family_fetch(href)
            now = self.ledger.now()
            return self._family_write(read, lambda body: ics_edit.move_day(body, f.instance, start, end, self.tz, now)
                                      if f.instance else ics_edit.move_one(body, start, end, self.tz, now),
                                      check, f.title)
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
        if c.get("smoke") and re.fullmatch(r"[0-9a-f]{1,32}", str(c["smoke"])):
            ics = ics.replace("END:VEVENT", f"X-HARNESS-SMOKE:{c['smoke']}\r\nEND:VEVENT", 1)
            if re.fullmatch(r"[0-9a-f]{1,32}", str(c.get("smoke_nonce") or "")):
                ics = ics.replace("END:VEVENT", f"X-HARNESS-SMOKE-NONCE:{c['smoke_nonce']}\r\nEND:VEVENT", 1)

        def run() -> dict:
            # A fixed address, written only where nothing is (If-None-Match), so a second try can
            # never make a second event.
            entry = {"cal": "family", "how": "delete", "href": href, "after": ics, "sent": ics, "etag": "",
                     "check": {"kind": "there"}}
            self._attempt(entry)
            out = self._bounded("family", self.client.put_new, href, ics)
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
        if entry.get("how") == "change" and entry.get("was") and now.get("etag") == entry["was"] \
                and self._gmail_content_moved(entry, now):
            # Eleventh round: only a write whose read back shows changed content under the same version.
            self._version_unmoved("gmail", self._write_words(entry, now.get("summary", "")))
        if entry.get("snap") is not None:
            snap = entry["snap"]
            # Every field the write sent is its change, whatever Google makes of it.
            intended = {**snap, **{k: "\0written" for k in (entry.get("wrote") or {})}}
            self._check_lost("gmail", now.get("summary", ""), snap, intended, _gmail_fields(now))
        if not self._gmail_shows(entry["check"], now):
            raise Stopped("unknown", undo=entry)
        return entry

    def _check_lost(self, provider: str, title: str, before: dict, intended: dict, back: dict) -> list:
        """Twelfth round: after a write sent without If-Match, its read back against the read just before it
        plus the change it meant (_lost_fields). A field outside the change that differs means someone else's
        edit landed around the write: kept on the step and told on a possible lost update card, with the
        values before and after. An edit wholly overwritten in the moment between that read and the write
        can't be seen afterwards; that's why such receipts say Unprotected."""
        lost = _lost_fields(before, intended, back)
        # Thirteenth round: a difference that's only this calendar's own normalisation, as its no-op round trip
        # in the smoke run showed (its baseline), isn't a lost update. The pinned stamps stay out as before.
        baseline = (((card_gate(self.ledger).get("conformance") or {}).get(provider) or {}).get("baseline")
                    or ((smoke_run(self.ledger).get("conformance") or {}).get(provider) or {}).get("baseline"))
        lost = [x for x in lost if not _matches_baseline(x, baseline)]
        if not lost:
            return []
        rec = self._recording
        if rec is not None:
            rec[2]["lost"] = [{"field": str(x["field"]), "was": x["was"], "now": x["now"]} for x in lost][:10]
        self._tell_lost(provider, title, lost)
        return lost

    def _tell_lost(self, provider: str, title: str, lost: list[dict]) -> None:
        name = provider_name(provider)

        def show(v) -> str:
            if v is None:
                return "nothing"
            if provider == "gmail" and isinstance(v, str):
                try:
                    v = json.loads(v)
                except ValueError:
                    pass
                v = json.dumps(v, sort_keys=True) if isinstance(v, (dict, list)) else str(v)
            text = " ".join(v) if isinstance(v, list) else str(v)
            text = re.sub(r"^[A-Z-]+(?:;[^:]*)?:", "", text.split("\n")[0]) if provider == "family" else text
            return "\u201c" + render.escape(text.strip()[:80]) + "\u201d"

        def label(f) -> str:
            return f[1].title().replace("-", " ") if isinstance(f, tuple) else str(f)[:1].upper() + str(f)[1:]
        lines = [f"<b>Possibly overwritten on {name}:</b> \u201c{_safe(title)}\u201d was changed without the "
                 "calendar's version check, and reading it back afterwards shows fields your change didn't touch "
                 "changed too, so someone else may have edited it at the same moment:"]
        lines += [f"• {render.escape(label(x['field']))}: was {show(x['was'])}, now {show(x['now'])}"
                  for x in lost[:6]]
        lines.append("Those are the values it read before and after. Harness changes nothing more for this.")
        with self.ledger.tx() as db:
            self._say(db, self.chat_id, None, render.fit("\n".join(lines)))
            self.ledger.event("calendar_possible_lost_update", {"calendar": provider, "fields": len(lost)}, db=db)
        log.warning("%s: a write sent without If-Match read back with %d field(s) outside its change changed: a "
                    "possible lost update, told", provider, len(lost))

    def _gmail_content_moved(self, entry: dict, now: dict) -> bool:
        """Whether a write's read back shows its fields changed from what they were before it (eleventh
        round): a write that left the event as it was may rightly keep its version."""
        old = entry.get("fields") or {}
        for key in (entry.get("wrote") or {}):
            was, got = old.get(key), now.get(key)
            if key in ("start", "end"):
                if not _same_start(self._gmail_when(was), self._gmail_when(got)):
                    return True
            elif (was or None) != (got or None):
                return True
        return False

    def _write_words(self, entry: dict, title: str = "") -> str:
        """The write, named for his message: what it did and to which event."""
        kind = (entry.get("check") or {}).get("kind", "")
        what = {"starts": "the move", "rrule": "the end of the series", "ends": "the end of the series",
                "days_off": "the removal of a day", "there": "the add"}.get(kind, "the change")
        return f"{what} of \u201c{_safe(title)}\u201d" if title else what

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
        if not _same_start(self._gmail_when(now.get("start")), self._gmail_when(e.get("start"))) \
                and not self._card_bound("gmail", e["id"]):
            raise Stopped("changed")               # with a card's record, the card's compare says (_card_etag)
        return now

    @staticmethod
    def _instance_only(f: "Found", now: dict) -> None:
        """A move or removal of one day of a Google series writes that day's own instance, never the
        series (seventh round): Google keeps each day's edits on its instance, so the other days'
        overrides, cancellations and attendees stay as they are. A day that reads as the series
        itself is never written."""
        if f.repeats and (not now.get("recurringEventId") or now.get("recurrence")):
            raise Stopped("whole_series", words="the calendar returned the whole series for that day")

    def _gmail_same(self, now: dict) -> Callable[[dict], bool]:
        """Whether Google's event as just read is the event the card showed, every field it bound
        (_card_etag). Carries the event as read (`now`, `shows`) for the receipt when it isn't."""
        try:
            got = self._gmail_print(now)
        except (Refuse, ValueError, KeyError, TypeError, AttributeError):
            got = None

        def same(b: dict) -> bool:
            return _print_same(got, b.get("print"))
        start, end = self._gmail_when(now.get("start")), self._gmail_when(now.get("end"))
        same.now = got
        same.shows = (f"\u201c{_safe(now.get('summary', ''))}\u201d at {self._at_words(start, end)}"
                      if start is not None and end is not None else "")
        return same

    def _gmail_guard(self, e: dict) -> str:
        """The If-Match for a Gmail move or removal of `e`, the event as just read (_card_etag)."""
        return self._send_guard("gmail", self._card_etag("gmail", e["id"], e.get("etag") or "", self._gmail_same(e),
                                                         self._shared("gmail", e)) or e.get("etag"))

    def _gmail_drop(self, address: str, e: dict) -> dict:
        entry = {"cal": "gmail", "how": "restore", "id": e["id"], "was": e.get("etag"),
                 "fields": {**{k: e[k] for k in _RESTORED if k in e}, "status": "confirmed"}}
        if e.get("recurringEventId"):
            entry["series"] = e["recurringEventId"]
        guard = self._gmail_guard(e)               # stale since the card: nothing is sent (eighth round)
        self._attempt(entry)
        out = self._bounded("gmail", self.google.drop, address, e["id"], guard)
        self._sent("gmail", "removal", guard, out)
        if out.kind == "changed":
            self._fenced("gmail", e["id"], {"kind": "gone"}, e.get("summary", ""), sent=guard or "")
        self._gmail_send(out, entry)
        if not self.google.really_gone(address, e["id"]):
            raise Stopped("unknown", undo=entry)
        return entry

    def _gmail_remove(self, f: Found) -> Step:
        def run() -> dict:
            address = self._gmail_address()
            now = self._gmail_fresh(address, f.raw)
            self._instance_only(f, now)
            return self._gmail_drop(address, now)
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
            guard = self._send_guard("gmail", master.get("etag"))
            if not guard:
                entry["snap"] = _gmail_fields(master)
            self._attempt(entry)
            self._gmail_send(self._bounded("gmail", self.google.change, address, series, {"recurrence": after},
                                           guard), entry)
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
            self._instance_only(f, now)
            entry = {"cal": "gmail", "how": "change", "id": e["id"], "fields": old, "wrote": fields,
                     "was": now.get("etag"), "check": {"kind": "starts", "start": _text(start), "end": _text(end)}}
            guard = self._gmail_guard(now)         # stale since the card: nothing is sent (eighth round)
            if not guard:
                entry["snap"] = _gmail_fields(now)  # twelfth round: for the lost-update compare (_check_lost)
            self._attempt(entry)
            out = self._bounded("gmail", self.google.change, address, e["id"], fields, guard)
            self._sent("gmail", "move", guard, out)
            if out.kind == "changed":
                self._fenced("gmail", e["id"], {"kind": "starts", "start": _text(start), "end": _text(end),
                                                "recurring": bool(e.get("recurringEventId") or e.get("recurrence"))},
                             f.title, sent=guard or "")
            self._gmail_send(out, entry)
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
        if c.get("smoke"):
            event["extendedProperties"] = {"private": {SMOKE_PROP: c["smoke"]}}
            if c.get("smoke_nonce"):
                event["extendedProperties"]["private"][SMOKE_NONCE_PROP] = c["smoke_nonce"]

        def run() -> dict:
            # Its id is fixed, so a second try can never make a second event. All it wrote is kept,
            # and what it left empty (a note, guests, attachments), so Undo leaves it alone once he's
            # changed or added to any of it.
            address = self._gmail_address()
            wrote = {"summary": event["summary"], "start": event["start"], "end": event["end"],
                     "location": event.get("location", ""), "recurrence": event.get("recurrence", []),
                     "description": "", "attendees": [], "attachments": []}
            entry = {"cal": "gmail", "how": "drop", "id": uid, "wrote": wrote, "check": {"kind": "there"}}
            self._attempt(entry)
            self._gmail_send(self._bounded("gmail", self.google.insert, address, event), entry)
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
        rec["back"] = iso(self.ledger.now())
        self._note_verified(plan, rec)
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
        the write gave, and for an add what it left empty too; on Family, what was sent and nothing
        more, by what it says, with the lines servers manage aside, so a server that keeps it its own
        way still reads as written and a note or an alert someone added or took away doesn't
        (caldav._as_sent). A removal found gone, or a rule, has nothing more to compare."""
        if entry.get("cal") == "gmail" and entry.get("how") != "restore":
            return self._as_written(read.get("event") or {}, entry.get("wrote") or {})
        if entry.get("cal") == "family" and entry.get("how") in ("put", "delete"):
            return caldav._as_sent(read.get("body") or "", entry.get("sent") or entry.get("after") or "")
        return True

    @staticmethod
    def _undo_entries(plan: dict) -> list[dict]:
        """What Undo puts back: every write known landed, in the order they were sent."""
        return [r["entry"] for r in sorted((r for part in plan["parts"] for r in part["steps"]
                                            if r["status"] == "landed" and r.get("entry")),
                                           key=lambda r: r.get("seq", 0))]

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
        landed = [r for r in landed if r.get("entry")]   # as asked already: nothing of ours to put back
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
            whole = Part(part["will"], part["done"], steps, name=part.get("name", ""),
                         bound=part.get("bound") or [], already=part.get("already", ""),
                         change=part.get("change") or {},
                         expect=part.get("expect") or [], loose=part.get("loose", ""))
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
    def _undo_button(self, db, proposal_id: str, label: str = "Undo", ttl_s: int = UNDO_TTL_S) -> tuple[list, list]:
        nonce = choices.mint(self.ledger, kind="calendar_change_undo", target=proposal_id,
                             chat_id=self.chat_id, ttl_s=ttl_s, db=db)
        return [[(label, choices.callback_data(nonce))]], [{"type": "choice", "nonce": nonce}]

    def _add_anyway_button(self, db, proposal_id: str) -> tuple[list, list]:
        nonce = choices.mint(self.ledger, kind="calendar_change_add_anyway", target=proposal_id,
                             chat_id=self.chat_id, ttl_s=UNDO_TTL_S, db=db)
        return [[("Add anyway", choices.callback_data(nonce))]], [{"type": "choice", "nonce": nonce}]

    def add_anyway(self, proposal_id: str) -> str:
        """His Add anyway on a receipt that found the very event already there: the add, as asked,
        as a second event under a new id. His tap is the go, so it runs now, with its own receipt
        and Undo; nothing is checked for "already there" again."""
        row = self.ledger.db.execute("SELECT * FROM calendar_changes WHERE proposal_id=?", (proposal_id,)).fetchone()
        p = self.ledger.db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone()
        if row is None or p is None:
            return "There's nothing to add there."
        changes = [part["change"] for part in _plan(row).get("parts", []) if part.get("already") and part.get("change")]
        if not changes:
            return "There's nothing to add there."
        params = {"changes": changes}
        with self.ledger.tx() as db:
            job = self.ledger.made_job(self.chat_id, "Add anyway: " + "; ".join(c["title"] for c in changes),
                                       kind="add_anyway", db=db)
            parent = self.ledger.get_meta(f"job_parent:{p['job_id']}") or p["job_id"]
            self.ledger.set_meta(f"job_parent:{job}", parent, db)
            pid = _create(self.ledger, job, params, p["policy_version"], db)
            self.ledger.set_meta(f"calendar_change_force:{pid}", "1", db)
            # Seventeenth round: its fixed ids come from the receipt's proposal (add_anyway_op), so the same tap
            # taken again writes to the same ids and the forced writer finds the first write there.
            self.ledger.set_meta(f"calendar_change_keys:{pid}", json.dumps(
                [add_anyway_key(proposal_id, i) for i in range(len(changes))]), db)
            self.ledger.set_meta(f"calendar_change_lines:{pid}", json.dumps(
                [render.change_line(c, self.tz, self.ledger.now()) for c in changes]), db)
            db.execute("UPDATE proposals SET state='approved' WHERE id=?", (pid,))
            self.ledger.transition(job, "proposed", db=db)
            self.ledger.transition(job, "approved", db=db)
            self.ledger.event("calendar_change_add_anyway", {"proposal": pid, "from": proposal_id}, db=db)
        return "Adding it as a second event now."

    def on_choice(self, kind: str, target: str) -> str:
        if kind in ("calendar_change_fast_on", "calendar_change_fast_keep"):
            return self.fast_path_tapped(kind == "calendar_change_fast_on", target)
        if kind == "calendar_change_fast_off":
            return self.fast_path_off_tapped()
        if kind == "calendar_change_smoke_clear":
            return self.clear_leftovers(target)
        if kind == "calendar_change_add_anyway":
            return self.add_anyway(target)
        if kind == "calendar_change_gate_open":
            return self.open_gate(target, by="owner tap")
        if kind == "calendar_change_conform_again":
            return self.conform_again(target)
        if kind == "calendar_change_step_start":
            return self.start_step(target)
        if kind in ("calendar_change_try_again", "calendar_change_restart"):
            return self.start_over(target, again=kind == "calendar_change_try_again")
        if kind in ("calendar_change_propose_again", "calendar_change_which") and self.reoffer is not None:
            return self.reoffer(kind, target)
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

    def start_over(self, pid: str, again: bool) -> str:
        """His Try again (after the calendar refused its own safety check) or Start again from now (after
        the one fresh card was refused in turn), eighth round: the change on a new card, read from the
        calendar just now, as a new change family, so it gets its own one fresh card. Never applied
        without his tap."""
        row = self.ledger.db.execute("SELECT x.state, p.* FROM proposals p JOIN calendar_changes x ON"
                                     " x.proposal_id=p.id WHERE p.id=?", (pid,)).fetchone()
        want = "fence_refused" if again else "stale"
        # Tenth round: Start again from now is also the one button after the first refusal on an unchanged
        # event on a calendar opened without the check.
        ok_states = (want,) if again else ("stale", "fence_refused")
        if row is None or row["state"] not in ok_states or self.start_again is None:
            return "Nothing changed."
        try:
            changes = json.loads(row["params_json"])["changes"]
            made = self.start_again(row, changes, "you asked to start this again, so it's read from the calendar "
                                                  "just now")
        except (Refuse, ValueError, KeyError, TypeError) as e:
            log.warning("starting a change again failed: %s", type(e).__name__)
            made = ""
        with self.ledger.tx() as db:
            self.ledger.event("calendar_change_started_again", {"proposal": pid, "how": want, "made": bool(made)},
                              db=db)
        return "A new card follows, read from the calendar just now." if made else "Nothing to start again there."

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
        if problem == "changed" and row["state"] == "landed_late":
            # A late landing's Undo is fenced by the event's version now (sixth round): changed since,
            # it's left as it is, and he sees how it reads now.
            shows = self._now_words(steps)
            self._reopen(row, f"<b>Not undone:</b> {_safe(self._names(_plan(row)))} changed on the calendar after it "
                              "went through late, so I left it as it is." + (f" It reads now: {shows}." if shows else "")
                              + " Undo here won't work while it stays that way.")
            return
        if problem is not None:
            again = (" Undo here won't work while it stays that way." if problem == "changed"
                     else " Undo tries again.")
            self._reopen(row, f"<b>Not undone:</b> {_safe(WORDS.get(problem, 'the calendar refused it'))}. "
                              "Nothing changed." + again)
            return
        left = list(steps)
        latest: dict[str, str] = {}          # an event undone a step ago has a new version
        self._rcw_seen = set()               # twelfth round: an undo sent without If-Match says so too
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
            first: dict[tuple, dict] = {}          # one event written twice: back as before the first
            for step in steps:
                first.setdefault((step["cal"], step.get("href") or step.get("id") or step.get("said")), step)
            back = [self._undone_reads(step) for step in first.values()]
            if any(b != "ok" for b in back):
                # Read once more a few seconds on before saying it isn't back (0.24.0, third round).
                self.sleep(READ_BACK_PAUSE_S)
                back = [self._undone_reads(step) for step in first.values()]
            log.info("undo of %s read back: %s", render.short(row["proposal_id"]), ",".join(back))
            if "differs" in back:
                words = (f"<b>Not confirmed:</b> I put {self._names(plan)} back, but a read of the calendar "
                         "doesn't show it the way it was.")
            elif "unread" in back:
                words = (f"<b>Undone, not confirmed:</b> I put {self._names(plan)} back, but a read of "
                         "the calendar afterward didn't answer.")
            else:
                words = "<b>Undone.</b> It's back the way it was."
                plan["undone_at"] = iso(self.ledger.now())          # read back as it was (the smoke run)
                plan["undone_entries"] = [{"cal": st.get("cal"), "id": st.get("id", ""), "href": st.get("href", "")}
                                          for st in first.values()]
            with self.ledger.tx() as db:
                db.execute("UPDATE calendar_changes SET undo_state='undone', settle_json=?, updated_at=?"
                           " WHERE proposal_id=?", (json.dumps(plan) if plan else "", iso(self.ledger.now()),
                                                    row["proposal_id"]))
                self._carry_versions(db, row, latest)
                if words != "<b>Undone.</b> It's back the way it was.":
                    self.ledger.set_meta(PROBLEM, "Calendar change: an undo didn't read back", db)
                if self._rcw_seen:
                    words += ("\n<i>Unprotected: " + " and ".join(provider_name(x) for x in sorted(self._rcw_seen))
                              + " was put back without the calendar's version check. It was read just before, but "
                              "an edit made at the same time by someone else could have been overwritten or "
                              "deleted.</i>")
                self._say(db, self.chat_id, row["job_id"], words)
            return
        if problem == "unknown":
            self._undo_not_yet(row)
            return
        with self.ledger.tx() as db:
            self.ledger.set_meta(PROBLEM, "Calendar change: an undo didn't finish", db)
        self._reopen(row, f"<b>Not fully undone:</b> {_safe(WORDS.get(problem, 'the calendar refused it'))}. "
                          "Undo tries what's left again.")

    def _now_words(self, steps: list) -> str:
        """How the events a change wrote read now, for a card that can't undo it (sixth round)."""
        out = []
        for step in steps[-3:]:
            try:
                if step.get("cal") == "gmail":
                    kind, ev = self.google.look(self.address(), step["id"])
                    if kind == "gone" or (ev or {}).get("status") == "cancelled":
                        out.append("that event is gone")
                    elif kind == "ok" and ev:
                        start, end = self._gmail_when(ev.get("start")), self._gmail_when(ev.get("end"))
                        out.append(f"\u201c{_safe(ev.get('summary', ''))}\u201d at {self._at_words(start, end)}")
                elif step.get("cal") == "family":
                    got, body = self.client.fetch(step["href"])
                    if got.kind == "gone":
                        out.append("that event is gone")
                    elif got.kind == "ok":
                        today = self._today()
                        occs = self._occurrences(body, *self._bounds([today - timedelta(days=1),
                                                                     today + timedelta(days=60)]))
                        if occs:
                            o = occs[0]
                            out.append(f"\u201c{_safe(o.summary)}\u201d at {self._at_words(o.start, o.end)}")
            except (Refuse, ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
                continue
        return "; ".join(dict.fromkeys(out))

    def _undone_reads(self, step: dict) -> str:
        """An undone write, read again: "ok" when the calendar shows it as it was before the
        change, "differs" when it doesn't, "unread" when the read can't tell."""
        try:
            if step["cal"] == "rule":
                return "ok"
            how = step["how"]
            if step["cal"] == "gmail":
                address = self.address()
                if not address or self.google is None:
                    return "unread"
                kind, cur = self.google.look(address, step["id"])
                if kind == "unknown":
                    return "unread"
                gone = kind == "gone" or (cur or {}).get("status") == "cancelled"
                if how == "drop":
                    return "ok" if gone else "differs"
                if how == "restore":
                    # The very occurrence or event it took off, back at its own time (a day of a
                    # series by its own id, 0.24.0, third round).
                    was = (step.get("fields") or {}).get("start")
                    if gone:
                        return "differs"
                    if was and not _same_start(self._gmail_when(cur.get("start")), self._gmail_when(was)):
                        return "differs"
                    return "ok"
                return "ok" if not gone and self._as_written(cur, step.get("fields") or {}) else "differs"
            out, body = self.client.fetch(step["href"])
            if out.kind not in ("ok", "gone"):
                return "unread"
            if how == "delete":
                return "ok" if out.kind == "gone" else "differs"
            if how == "restore":
                return "ok" if out.kind == "ok" else "differs"
            if out.kind != "ok":
                return "differs"
            if caldav._unchanged(body, step.get("before", "")):
                return "ok"
            # A server can store lines of its own: what counts is the days and times it holds.
            today = self._today()
            lo, hi = self._bounds([today - timedelta(days=1), today + timedelta(days=400)])
            shape = lambda ics: sorted((o.instance, _moment(o.start), _moment(o.end), o.summary)   # noqa: E731
                                       for o in self._occurrences(ics, lo, hi))
            return "ok" if shape(body) == shape(step.get("before", "")) else "differs"
        except (ValueError, KeyError, TypeError, AttributeError, ical.Unreadable):
            return "unread"

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

    @staticmethod
    def _made_here(step: dict) -> bool:
        """An add's Undo takes off only the event that add made: its own fixed id ("cm" and 32 hex
        on Gmail, "hm-" and 32 hex on Family, from _uid), never one that was there before."""
        if step["cal"] == "gmail":
            return bool(_MADE_GMAIL.fullmatch(step.get("id") or ""))
        return bool(_MADE_FAMILY.search(caldav.href_path(step.get("href") or "")))

    def _undo_step(self, step: dict, latest: dict[str, str]) -> str:
        if step["cal"] in ("gmail", "family") and step.get("how") in ("drop", "delete") \
                and not self._made_here(step):
            return "not_made"
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
            return self._after_undo(self._bounded("family", self.client.put_new, href, step["before"]), href, latest)
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
            kind = self._bounded("family", self.client.remove_at, href, self._send_guard("family", out.etag or "")).kind
            return "ok" if kind == "gone" else kind
        return self._after_undo(self._bounded("family", self.client.replace, href,
                                              self._send_guard("family", out.etag or ""), step["before"]), href, latest)

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
            elif key in ("recurrence", "attendees", "attachments"):
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
            # Fenced by the version just read (sixth round): anyone's change since is refused.
            out = self._bounded("gmail", self.google.change, address, uid, step["fields"], (cur or {}).get("etag") or None)
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
            guard = self._send_guard("gmail", cur.get("etag"))
            out = (self._bounded("gmail", self.google.drop, address, uid, guard) if step["how"] == "drop"
                   else self._bounded("gmail", self.google.change, address, uid, step["fields"], guard))
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


def _classify(provider: str, out, applied: bool, readable: bool) -> str:
    """One stale write's verdict (tenth round): "ignored" when a read shows it applied; "enforced" only for
    the provider's documented stale-precondition answer with a read showing it wasn't; else "unknown"."""
    if applied:
        return "ignored"
    status = getattr(out, "status", None)
    if readable and getattr(out, "kind", "") in ("changed", "exists") and status in STALE_CODES.get(provider, ()):
        return "enforced"
    return "unknown"


def _conformance_result(kinds: dict) -> str:
    """The conformance item's verdict over its write kinds: "enforced" only when every kind is; "ignored"
    when an edit (one-off or one day of a series) was applied though stale; "partial" when only the
    removal isn't enforced; else "unknown" (a refused fresh edit included: record["fresh_failed"])."""
    got = [kinds.get(k, "unknown") for k in CONFORMANCE_KINDS]
    if all(x == "enforced" for x in got):
        return "enforced"
    if "incompatible" in got:
        return "unknown"
    if kinds.get("edit") == "ignored" or kinds.get("instance") == "ignored":
        return "ignored"
    if kinds.get("edit") == "enforced" and kinds.get("instance") == "enforced":
        return "partial"
    return "unknown"


def _strength(etags: list) -> str:
    """Twelfth round: "weak" when any version read was weak, "strong" when every one was strong, "none" when
    none came, "" when nothing was read."""
    if not etags:
        return ""
    if any(_weak(x) for x in etags):
        return "weak"
    return "strong" if all(etags) else "none"


def _out_words(out, what: str) -> str:
    status = getattr(out, "status", None)
    return f"{what} was answered {getattr(out, 'kind', '?')}" + (f" ({status})" if status else "")


def _answer_words(answers: dict) -> str:
    return "; ".join(f"{k}: {v}" for k, v in (answers or {}).items()) or "no clear answer"


def _length(span: timedelta) -> str:
    """1 hour; 30 minutes; 1 hour 30 minutes."""
    minutes = int(span.total_seconds() // 60)
    hours, rest = divmod(minutes, 60)
    parts = ([f"{hours} hour{'s' * (hours != 1)}"] if hours else []) + \
        ([f"{rest} minute{'s' * (rest != 1)}"] if rest or not hours else [])
    return " ".join(parts)


def _create(ledger: Ledger, job_id: str, params: dict, policy_version: str, db) -> str:
    from . import approvals
    return approvals.create_proposal(ledger, job_id=job_id, effect_type=effects.CALENDAR_CHANGE, params=params,
                                     policy_version=policy_version, ttl_s=UNDO_TTL_S, db=db)


def _offer_key(c: dict) -> str:
    """One change, however its title is spaced or cased (runner._change_key's twin), as a string."""
    return json.dumps([c.get("op"), c.get("calendar"), " ".join(str(c.get("title", "")).casefold().split()),
                       c.get("dates", ""), c.get("start", ""), c.get("end", ""), c.get("days", ""),
                       c.get("until", "")])


def _moment(when) -> str:
    """One moment however it was written, to tell the same change named twice."""
    return when.astimezone(timezone.utc).isoformat() if isinstance(when, datetime) else when.isoformat()


def _text(when) -> str:
    """A time as family_copy.py keeps it."""
    return when.isoformat()


def _tail(ident: str) -> str:
    """The last six letters and digits of an event id or address, as a card names it."""
    return re.sub(r"[^0-9A-Za-z]", "", caldav.href_path(ident or "").rsplit("/", 1)[-1].removesuffix(".ics"))[-6:]


def _bound_id(part: dict) -> str:
    bound = part.get("bound") or []
    return bound[0].get("id", "") if bound else ""


def _notes_norm(notes: str) -> str:
    """Notes as compared (seventh round): only line endings and trailing whitespace are evened out, so
    any other edit, a doubled space inside a line included, reads as a change."""
    lines = (notes or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.rstrip() for line in lines).rstrip()


def _print(title: str, start, end, rule: list, location: str, notes: str, attendees=(), organizer: str = "",
           transparency: str = "") -> dict:
    """An event's shown fields, compared whole (_card_etag): title, start, end, all day or not, its
    series's rule, location, its notes (as a hash: they're compared, never kept), and (seventh round)
    its attendees with each one's answer, its organiser and whether it shows as busy."""
    def at(x) -> str:
        return x.astimezone(timezone.utc).isoformat() if isinstance(x, datetime) else x.isoformat()
    # Ninth round: one shape whichever read gave it (a listing or a read by id): an answer left out is
    # "needs action", both calendars' spellings of it are one, and the rule's lines are ordered.
    def answer(x) -> str:
        x = str(x or "").strip().lower().replace("-", "")
        return x or "needsaction"
    people = sorted({(str(a).strip().lower(), answer(s)) for a, s in attendees if a})
    return {"title": exact_title(title), "start": at(start), "end": at(end),
            "all_day": not isinstance(start, datetime),
            "rule": sorted(str(r).strip() for r in rule if str(r).strip()),
            "location": " ".join((location or "").split()),
            "notes": hashlib.sha256(_notes_norm(notes).encode()).hexdigest()[:16],
            "attendees": [list(x) for x in people],
            "organizer": (organizer or "").strip().lower().removeprefix("mailto:"),
            "transparency": (transparency or "opaque").strip().lower()}


def _day_passed(c: dict, today: date) -> bool:
    """Whether every day a change is for is before today (ninth round): an add's day, a series's last day
    (only when it has one), or each date a move or removal names."""
    try:
        op = c.get("op")
        if op == "add":
            return datetime.fromisoformat(c["start"]).date() < today
        if op == "add_series":
            return bool(c.get("until")) and datetime.fromisoformat(c["until"]).date() < today
        days = [x for x in str(c.get("dates") or "").split(",") if x]
        if op == "move" and c.get("start"):
            days.append(c["start"][:10])
        return bool(days) and all(date.fromisoformat(x[:10]) < today for x in days)
    except (KeyError, ValueError, TypeError):
        return False


def _first_day(c: dict) -> date | None:
    """The first day a change is for (tenth round), None when it can't be read."""
    try:
        if c.get("start"):
            return datetime.fromisoformat(c["start"]).date()
        days = sorted(x[:10] for x in str(c.get("dates") or "").split(",") if x)
        return date.fromisoformat(days[0]) if days else None
    except (ValueError, TypeError):
        return None


def _print_same(now: dict | None, card: dict | None) -> bool:
    """Whether an event as read now is the event its card bound (ninth round): only the fields the card
    bound are compared, each in _print's one shape."""
    if not now or not card:
        return False
    return all(now.get(k) == v for k, v in card.items())


_FIELD_WORDS = (("title", "title"), ("start", "start time"), ("end", "end time"), ("all_day", "all-day setting"),
                ("rule", "repeat"), ("location", "location"), ("notes", "notes"), ("attendees", "guests"),
                ("organizer", "organiser"), ("transparency", "busy setting"))


def _changed_fields(was: dict, now: dict | None) -> list[str]:
    """Which of the fields a card bound read otherwise now (eighth round), in words."""
    if not was or not now:
        return []
    return [words for key, words in _FIELD_WORDS if was.get(key) != now.get(key)]


def _and(items: list[str]) -> str:
    items = list(items)
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


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
