"""What a Family event means for him, phase 2: live blocks, his answers, receipts and Undo.

Phase 1 (meaning.py) judges Family events and scores the judgments in shadow. This adds what
turns them into his calendar and lets him correct it, all model-free:

  * Live mode, behind the `meaning_live` option (off by default, separate from
    `meaning_shadow`). When on, family_gmail.py takes its wants from the judgments instead of
    the old title rules and options: confirmed blocks, and "Maybe busy (...)" provisional
    blocks for supervision or transport within 48 hours, written free so the work holds
    script (which skips free events) never copies them to work. Off is exactly the old
    behavior, so switching it off is the rollback. Every family_gmail guard stays.
  * One question, with buttons, when a judgment is unsure or has no confirmed example
    behind it and its blocks would change his availability in the next 14 days. A fixed
    template and the event's cleaned, shortened title; never model text. At most one open
    per kind of event, three open at once, and never the same question twice. Within 48
    hours it goes at once; otherwise one batch a day.
  * His tap is a confirmed example (the event's structured features and what he said it
    means), and the judgments whose candidates include it are judged again under the usual
    limits. [Depends] stores nothing and marks the kind "ask each time". The occurrence he
    answered about follows his answer at once.
  * A receipt card for each new confirmed block, sent with the next morning digest once a
    later read of Gmail finds the block as written (title, start and end): a write that Google
    answered ok isn't enough. Three reads that don't find it, and the card says it was written
    but not confirmed, with the same buttons:
    [Not mine] removes it and stores "nothing" for that kind; [Wrong time] removes it and
    stores the obligation with its window marked untrusted, so the next one asks;
    [Just this once] removes only that block and stores nothing. A block removed by hand on
    Google teaches nothing.
  * What he told Cain a kind of event means, sent by Cain from his record (handover.py
    /meanings), stored as confirmed examples with source "dane-via-cain". Strictly checked:
    allowed meanings only, bounded lengths, words cleaned. Sending the same table again
    changes nothing.
  * Where an event he goes to is: a street address in its location, else his place book
    (places.py), else the map by the location's name near home (drive.find_place), whether
    or not the judgment named the place, unless it was judged to be at home or school. A
    place none of them knows gets one card asking him where it is.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
from datetime import date, datetime, time, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import choices, family_rules, meaning, places, render
from .family_gmail import DROP_TITLE, PICK_TITLE, Want, _is_real, _key
from .ledger import Ledger, iso

log = logging.getLogger("harness.meaning_live")

OPTION = "meaning_live"
SOURCE_CAIN = "dane-via-cain"
ASK_AHEAD = timedelta(days=14)
URGENT = timedelta(hours=48)
MAX_OPEN = 3
BATCH_FROM = time(7, 0)                 # the day's batch of questions, not before breakfast
MIN_TTL_S = 3600
MAX_TTL_S = 14 * 24 * 3600
RECEIPT_TTL_S = 7 * 24 * 3600
MAX_RECEIPTS = 5                        # receipt cards with one digest; the rest the next day
READS_TO_CONFIRM = 3                    # reads of Gmail that don't find a block before it's "not confirmed"

# Each answer, as what it stores: types, and (for presence) the scope.
CRITICAL_ASK = {"supervision": "are you watching the kids?", "transport": "are you driving?"}
CRITICAL_BUTTONS = (("Yes", "yes"), ("No", "no"), ("Depends", "depends"))
PRESENCE_BUTTONS = (("All of it", "all"), ("Part of it", "part"), ("No", "no"))
UNDO_BUTTONS = (("Not mine", "not_mine"), ("Wrong time", "wrong_time"),
                ("Just this once", "once"))
ANSWERS = frozenset(c for _, c in CRITICAL_BUTTONS + PRESENCE_BUTTONS)
UNDOS = frozenset(c for _, c in UNDO_BUTTONS)

# What he told Cain, as stored: types and place.
MEANINGS = {"kids": (["supervision"], "none"), "me": (["presence"], "none"),
            "school": (["transport"], "school"), "drive": (["transport"], "event_location"),
            "none": ([], "none")}
# A dated row is his answer about one event, applied as if he had answered its card.
EVENT_ANSWER = {"kids": ("supervision", "yes"), "me": ("presence", "yes"),
                "school": ("transport", "yes"), "drive": ("transport", "yes"), "none": ("*", "no")}
MAX_ROWS = 60
MAX_KIND = 80
MAX_KIND_WORDS = 8
MEETINGS = ("presence", "hard_unavailable", "supervision")
RUN_TITLES = frozenset({DROP_TITLE, PICK_TITLE, meaning.MAYBE[DROP_TITLE], meaning.MAYBE[PICK_TITLE]})
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def live_on(data_dir: str) -> bool:
    try:
        with open(os.path.join(data_dir, "options.json"), encoding="utf-8") as f:
            return json.load(f).get(OPTION) is True
    except (OSError, ValueError, AttributeError):
        return False


# -- what he told Cain: checked in the HTTP thread, before anything is queued ---------------------

def validate_rows(body) -> tuple[list[dict] | None, str]:
    """The rows, cleaned, or None and a fixed reason (never an echo of what was sent)."""
    rows = body.get("rows") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        return None, "rows must be a list"
    if len(rows) > MAX_ROWS:
        return None, f"at most {MAX_ROWS} rows"
    today = datetime.now().date()
    out = []
    for n, row in enumerate(rows, 1):
        if not isinstance(row, dict) or not ({"kind", "meaning", "said_on"} <= set(row)
                                              <= {"kind", "meaning", "said_on", "for"}):
            return None, f"row {n}: needs exactly kind, meaning and said_on (and for, a date)"
        kind, said_meaning, said_on = row["kind"], row["meaning"], row["said_on"]
        if not isinstance(kind, str) or not 0 < len(kind) <= MAX_KIND:
            return None, f"row {n}: kind must be 1 to {MAX_KIND} characters"
        words = family_rules.words(kind)
        if not words or len(words) > MAX_KIND_WORDS or any(len(w) > 30 for w in words):
            return None, f"row {n}: kind must be 1 to {MAX_KIND_WORDS} plain words"
        if said_meaning not in MEANINGS:
            return None, f"row {n}: meaning must be one of {', '.join(MEANINGS)}"
        if not isinstance(said_on, str) or not _DATE.fullmatch(said_on):
            return None, f"row {n}: said_on must be a date like 2026-11-08"
        try:
            day = date.fromisoformat(said_on)
        except ValueError:
            return None, f"row {n}: said_on must be a date like 2026-11-08"
        if day.year < 2020 or day > today + timedelta(days=1):
            return None, f"row {n}: said_on must not be in the future"
        clean = {"words": sorted(words), "meaning": said_meaning, "said_on": said_on}
        on = row.get("for")
        if on is not None:
            # His answer about one event: the Family event with these words on that day.
            if not isinstance(on, str) or not _DATE.fullmatch(on):
                return None, f"row {n}: for must be a date like 2026-11-21"
            try:
                date.fromisoformat(on)
            except ValueError:
                return None, f"row {n}: for must be a date like 2026-11-21"
            clean["for"] = on
        out.append(clean)
    return out, ""


# -- small pieces --------------------------------------------------------------------------------

def kind_key(ev: meaning.Ev) -> str:
    occ = ev.item.occ
    if ev.kind == "series":
        return "s:" + hashlib.sha256(occ.uid.encode()).hexdigest()[:16]
    w = family_rules.words(occ.summary)
    return "w:" + " ".join(sorted(w)) if w else "e:" + ev.key


NONE_DAYS = 30                      # how far ahead a missing block explains itself in the log


def no_block_why(j: meaning.Judgment, backed: bool, examples: dict, answer) -> str:
    """Why a judged event gave no block, in fixed words and counts (meaning.judged_why)."""
    if answer is not None and answer[1] == "no":
        reason = "he answered no"
    elif not j.obligations:
        reason = "judged as nothing for him"
    elif not backed:
        reason = "not backed by one of his answers, and a non-urgent block needs that"
    elif j.unsure or any(ob.certainty != "high" for ob in j.obligations):
        reason = "the judge wasn't sure, and a non-urgent block needs a sure judgment"
    else:
        reason = "its blocks had all ended"
    return f"{reason} ({meaning.judged_why(j, backed, examples)})"


def _occ_id(occ) -> str:
    return f"{occ.uid}|{occ.instance}"


# Where a presence block is held, as judged: at home or school, the event's location isn't
# where he goes. Anything else ("event_location", or no place said) is the event's location.
NOT_THERE = ("home", "school")


def _place(j: meaning.Judgment, kind: str) -> str:
    return next((o.place for o in j.obligations if o.type == kind), "none")


def ask_type(j: meaning.Judgment) -> str | None:
    """What one question would ask about: the busiest thing the judgment says, or, when it
    can't tell whether the event ties him up at all, whether it does."""
    have = {o.type for o in j.obligations}
    for kind in ("supervision", "transport"):
        if kind in have:
            return kind
    if have & {"presence", "hard_unavailable"}:
        return "presence"
    if j.unsure and not have - {"partner_away"}:
        return "presence"
    return None


def _day(d: datetime) -> str:
    return f"{d:%a %b} {d.day}"


def _when(d: datetime, all_day: bool) -> str:
    return _day(d) if all_day else f"{_day(d)} {meaning._clock(d)}"


def receipt_id(key: str, generation: int) -> str:
    """One receipt per block as written: its key, and which writing of it."""
    return f"{key[:24]}.{generation}"


def _span(start: datetime, end: datetime) -> str:
    """Fri Nov 20, 1:00 PM to 3:00 PM (the end's day too when it's another day)."""
    until = meaning._clock(end) if end.date() == start.date() else f"{_day(end)}, {meaning._clock(end)}"
    return f"{_day(start)}, {meaning._clock(start)} to {until}"


def question_text(ask: str, title: str, start: datetime, all_day: bool) -> str:
    """A fixed template and the event's cleaned, shortened title. Nothing a model wrote."""
    shown = render.escape(meaning.shown(title))
    if ask in CRITICAL_ASK:
        return f"{shown}, {_when(start, all_day)}: {CRITICAL_ASK[ask]}"
    return f"{shown}, {_day(start)}: does it tie you up?"


def _forced(j: meaning.Judgment, types: tuple[str, ...], sp: meaning.Span,
            all_day: bool) -> meaning.Judgment:
    """The judgment as he confirmed it for one occurrence: only the asked types, sure. With no
    window judged, a timed event's own time; an all-day one has none to give."""
    obs = tuple(meaning.Rel(o.type, o.s, o.e, o.rs, o.re, o.place, "high")
                for o in j.obligations if o.type in types)
    if not obs and sp.minutes > 0 and not all_day:
        for kind in ("presence", "supervision"):
            if kind in types:
                obs = (meaning.Rel(kind, 0, sp.minutes, certainty="high"),)
                break
    return meaning.Judgment(obs, (), False)


def _asked_types(ask: str) -> tuple[str, ...]:
    return ("presence", "hard_unavailable") if ask == "presence" else (ask,)


class MeaningLive:
    def __init__(self, ledger: Ledger, shadow, calendar, *, tz: str, on_fn: Callable[[], bool],
                 name_fn: Callable[[], str] = lambda: ""):
        self.ledger = ledger
        self.shadow = shadow               # meaning.MeaningShadow: Family as last read, and poke()
        self.calendar = calendar
        self.tz = tz
        self.on_fn = on_fn
        self.name_fn = name_fn
        self.chat_id: int | None = None
        self._why: dict[str, dict] = {}    # Gmail key -> what the block is for (receipts)
        self._none_said: dict[str, str] = {}   # occurrence -> why it got no block, as last logged
        self._revive_tried: tuple = ()     # the read the one-time revive was last tried at
        self.places = places.PlaceBook(ledger, tz=tz)   # where a named place is (places.py)

    def bind(self, owner: int) -> None:
        self.chat_id = owner

    def on(self) -> bool:
        try:
            return bool(self.on_fn())
        except Exception:
            return False

    # -- what Gmail should hold (family_gmail.py, live mode) -----------------------------------
    def _answers(self) -> dict[str, tuple[str, str]]:
        return {r["occurrence"]: (r["ask"], r["answer"]) for r in self.ledger.db.execute(
            "SELECT occurrence, ask, answer FROM meaning_questions WHERE state='answered'"
            " ORDER BY updated_at")}

    def _event_answers(self) -> dict[tuple[str, str], tuple[str, str]]:
        """His dated answers from Cain's record: (words, day) -> (ask, code). Exactly that
        event's words on exactly that day; anything else stays with the judge."""
        return {(r["words"], r["day"]): EVENT_ANSWER[r["meaning"]] for r in self.ledger.db.execute(
            "SELECT words, day, meaning FROM meaning_event_answers") if r["meaning"] in EVENT_ANSWER}

    @staticmethod
    def _answer_for(occ, sp, answers, dated):
        """His card answer for this occurrence, else his dated answer for it from the record."""
        got = answers.get(_occ_id(occ))
        if got is not None:
            return got
        words = " ".join(sorted(family_rules.words(occ.summary)))
        return dated.get((words, sp.anchor.date().isoformat()))

    def wants(self, items, now: datetime, *, find=None) -> dict[str, Want]:
        """From the judgments alone, with no model: the same judgment and the same Family give
        the same wants. The usual skips first (his copies, holds, his own name)."""
        evs = meaning.events_of(items, self.tz, self.name_fn())
        examples = {e.id: e for e in meaning.active_examples(self.ledger)}
        answers = self._answers()
        dated = self._event_answers()
        out: dict[str, Want] = {}
        why: dict[str, dict] = {}
        seen: set = set()
        self.places.begin()
        none: dict[str, tuple[datetime, str, str]] = {}
        for ev in evs.values():
            row = meaning.stored(self.ledger, ev.key)
            j = meaning.last_good(row)
            if j is None:
                continue                   # not judged yet: nothing, and no guess (judged next read)
            backed = meaning.supported(j, examples)
            for item in ev.occurrences:
                occ = item.occ
                sp = meaning.span_of(occ, self.tz)
                answer = self._answer_for(occ, sp, answers, dated)
                blocks = self._blocks(j, backed, sp, now, answer, occ.all_day)
                if not blocks:
                    none[_occ_id(occ)] = (sp.anchor, meaning.shown(occ.summary),
                                          no_block_why(j, backed, examples, answer)
                                          + self._his_for(family_rules.words(occ.summary), row))
                plain_used = False
                for i, b in enumerate(blocks):
                    if b.end <= now:
                        continue
                    if b.title in (DROP_TITLE, meaning.MAYBE[DROP_TITLE]):
                        run = "drop"
                    elif b.title in (PICK_TITLE, meaning.MAYBE[PICK_TITLE]):
                        run = "pick"
                    elif b.type in MEETINGS and not plain_used:
                        run, plain_used = "", True     # the key the old rules gave it
                    else:
                        run = f"m{i}:{b.type}"
                    if run in ("drop", "pick"):
                        moment = (run, b.start)
                        if moment in seen:
                            continue       # two Family events for one day are one run
                        seen.add(moment)
                    key = _key(occ, run)
                    place = "school" if run in ("drop", "pick") else _place(j, b.type)
                    where = ""
                    if b.type == "presence" and place not in NOT_THERE:
                        # The event's own location, whether or not the judgment named it: a
                        # street address in it, else his place book, else the map by its name
                        # (`find`). A place none of them knows is asked about once (places.py).
                        where, ask = self.places.resolve(occ.location, find)
                        if ask:
                            self.places.unresolved(occ.location, occ.summary, b.start)
                    out[key] = Want(key, b.title, b.start, b.end,
                                    "me" if b.type == "presence" else "", b.state, where,
                                    not any(x.type == "transport" for x in blocks))
                    why[key] = {"kind": kind_key(ev), "said": meaning.shown(occ.summary),
                                "words": sorted(family_rules.words(occ.summary)),
                                "who": meaning.who_for(occ.summary),
                                "series": occ.uid if ev.kind == "series" else "",
                                "month": sp.anchor.month, "type": b.type, "place": place}
        self._why = why
        self._say_none(none, now)
        return out

    def _his_for(self, words: frozenset[str], row=None) -> str:
        """How many of his own answers (not seeded ones) are for these words, by state, and
        whether an active one was in front of the judge: tells a judge that ignored his answer
        from one that never saw it, never got it, or had it overruled."""
        states: dict[str, int] = {}
        active: set[str] = set()
        for r in self.ledger.db.execute("SELECT id, source, words, state FROM meaning_examples"):
            ex_words = frozenset((r["words"] or "").split())
            if r["source"] not in meaning.SEEDED and ex_words and ex_words <= words:
                states[r["state"]] = states.get(r["state"], 0) + 1
                if r["state"] == "active":
                    active.add(r["id"])
        said = ", ".join(f"{n} {st}" for st, n in sorted(states.items())) or "none"
        seen = ""
        if active and row is not None:
            try:
                shown = set(json.loads(row["candidates"] or "[]"))
            except ValueError:
                shown = set()
            seen = f"; the judge {'saw' if active & shown else 'never saw'} it"
        return f"; his answers for these words: {said}{seen}"

    def _say_none(self, none: dict[str, tuple[datetime, str, str]], now: datetime) -> None:
        """One log line for each Family event in the next NONE_DAYS that gets no block, with
        why, written again only when the why changes. So a missing block explains itself."""
        soon = {k: v for k, v in none.items() if now <= v[0] <= now + timedelta(days=NONE_DAYS)}
        for k, (at, said, why) in sorted(soon.items(), key=lambda kv: kv[1][0]):
            if self._none_said.get(k) != why:
                log.info("no block for %s on %s: %s", said,
                         at.astimezone(ZoneInfo(self.tz)).strftime("%a %b %d %I:%M %p"), why)
        self._none_said = {k: v[2] for k, v in soon.items()}

    @staticmethod
    def _blocks(j, backed, sp, now, answer, all_day: bool) -> list[meaning.Block]:
        blocks = meaning.blocks_for(j, sp, now, supported=backed)
        if answer is None:
            return blocks
        ask, code = answer
        if ask == "*":
            return [] if code == "no" else blocks
        asked = _asked_types(ask)
        rest = [b for b in blocks if b.type not in asked]
        if code == "no":
            return rest
        if code in ("yes", "all", "part"):
            return rest + meaning.blocks_for(_forced(j, asked, sp, all_day), sp, now, supported=True)
        return blocks

    # -- receipts ----------------------------------------------------------------------------------
    def applied(self, want: Want, generation: int) -> None:
        """A new confirmed block was written to Gmail (not a refresh, not a move): one receipt,
        held until a later read finds the block as written (family_gmail.py)."""
        meta = self._why.get(want.key)
        if meta is None or want.state != "confirmed":
            return
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("INSERT OR IGNORE INTO meaning_receipts(id, gmail_key, title, said, start,"
                       " end, features, state, action, created_at, updated_at)"
                       " VALUES(?,?,?,?,?,?,?,'written','',?,?)",
                       (receipt_id(want.key, generation), want.key, want.title, meta["said"],
                        want.start.isoformat(), want.end.isoformat(), json.dumps(meta), now, now))

    def moved(self, key: str, generation: int) -> None:
        """Its block moved before its receipt went out: the receipt waits for a read of where it is
        now, and then says that."""
        with self.ledger.tx() as db:
            db.execute("UPDATE meaning_receipts SET state='written', reads=0, updated_at=? WHERE id=?"
                       " AND state='new'", (iso(self.ledger.now()), receipt_id(key, generation)))

    def written(self) -> list:
        """Receipts waiting for a read of Gmail to find their block as written."""
        return self.ledger.db.execute("SELECT * FROM meaning_receipts WHERE state='written'"
                                      " ORDER BY start").fetchall()

    def read_back(self, rid: str, found: bool | None, *, title: str | None = None,
                  start: datetime | None = None, end: datetime | None = None) -> None:
        """What a read of Gmail found for this receipt's block. True: there as written, so its
        receipt goes out with the next digest, saying what's there (title, start and end when
        given: a block moved since is told where it is). False: not there as written; after
        READS_TO_CONFIRM of those, the next digest says it was written but not confirmed. None:
        there's nothing left to tell (the block is gone, his, written again, or over)."""
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            if found is None:
                db.execute("UPDATE meaning_receipts SET state='past', updated_at=? WHERE id=?"
                           " AND state='written'", (now, rid))
            elif found:
                db.execute("UPDATE meaning_receipts SET state='new', updated_at=? WHERE id=?"
                           " AND state='written'", (now, rid))
                if title is not None and start is not None and end is not None:
                    db.execute("UPDATE meaning_receipts SET title=?, start=?, end=? WHERE id=? AND state='new'",
                               (title, start.isoformat(), end.isoformat(), rid))
            else:
                db.execute("UPDATE meaning_receipts SET reads=reads+1, updated_at=? WHERE id=?"
                           " AND state='written'", (now, rid))
                db.execute("UPDATE meaning_receipts SET state='unconfirmed' WHERE id=? AND state='written'"
                           " AND reads>=?", (rid, READS_TO_CONFIRM))

    def digest_line(self) -> str:
        rows = self.ledger.db.execute("SELECT title, start, state FROM meaning_receipts WHERE state IN"
                                      " ('new','unconfirmed') ORDER BY start").fetchall()
        if not rows:
            return ""
        shown = min(len(rows), MAX_RECEIPTS)
        # Named, never just counted (Nov 11): each block and its day.
        zone = ZoneInfo(self.tz)

        def named(r) -> str:
            return f"{r['title']} {_day(datetime.fromisoformat(r['start']).astimezone(zone))}"   # escaped in the digest
        held = [named(r) for r in rows[MAX_RECEIPTS:]]
        unsure = [named(r) for r in rows[:MAX_RECEIPTS] if r["state"] == "unconfirmed"]
        more = f" (tomorrow: {', '.join(held)})" if held else ""
        line = (f"New on Gmail from what Family events mean: {shown} block{'s' * (shown != 1)}, "
                f"each on its own card{more}.")
        if unsure:
            line += f" Written but not confirmed by a read of your calendar: {', '.join(unsure)}."
        return line

    def send_receipts(self) -> int:
        """With the morning digest: one card per new confirmed block, three buttons each, once a
        read found it as written; one written but not confirmed says so, with the same buttons.
        One card each, so one tap can't use up another block's buttons."""
        if self.chat_id is None:
            return 0
        rows = self.ledger.db.execute("SELECT * FROM meaning_receipts WHERE state IN ('new','unconfirmed')"
                                      " ORDER BY start LIMIT ?", (MAX_RECEIPTS,)).fetchall()
        zone = ZoneInfo(self.tz)
        now = self.ledger.now()
        for r in rows:
            start = datetime.fromisoformat(r["start"]).astimezone(zone)
            if datetime.fromisoformat(r["end"]) <= now:
                self._receipt(r["id"], "past")
                continue
            end = datetime.fromisoformat(r["end"]).astimezone(zone)
            what = f"{render.escape(r['title'])}, {_span(start, end)}, for {render.escape(r['said'])} on Family."
            if r["state"] == "new":
                text = f"Added to your Gmail: {what} Nothing to do if that's right; tap a button only if it's wrong."
            else:
                text = (f"Written to your Gmail but not confirmed: {what} A read of your calendar hasn't found it "
                        "as written, so it may not be there. Nothing to do if that's fine; tap a button only if "
                        "it's wrong.")
            with self.ledger.tx() as db:
                nonces = [(label, choices.mint(self.ledger, kind="meaning_undo",
                                               target=f"{r['id']}:{code}", chat_id=self.chat_id,
                                               ttl_s=RECEIPT_TTL_S, db=db))
                          for label, code in UNDO_BUTTONS]
                self.ledger.enqueue(chat_id=self.chat_id, kind="reply", text=render.fit(text), db=db,
                                    buttons=[[(label, choices.callback_data(n)) for label, n in nonces]],
                                    binds=[{"type": "choice", "nonce": n} for _, n in nonces])
                db.execute("UPDATE meaning_receipts SET state='shown', updated_at=? WHERE id=?",
                           (iso(now), r["id"]))
        return len(rows)

    def _receipt(self, rid: str, state: str, action: str | None = None) -> None:
        with self.ledger.tx() as db:
            if action is None:
                db.execute("UPDATE meaning_receipts SET state=?, updated_at=? WHERE id=?",
                           (state, iso(self.ledger.now()), rid))
            else:
                db.execute("UPDATE meaning_receipts SET state=?, action=?, updated_at=? WHERE id=?",
                           (state, action, iso(self.ledger.now()), rid))

    def removals(self) -> list[tuple[str, str, str]]:
        """Undo taps waiting for family_gmail.py to take the block off: (id, Gmail key, action)."""
        return [(r["id"], r["gmail_key"], r["action"]) for r in self.ledger.db.execute(
            "SELECT id, gmail_key, action FROM meaning_receipts WHERE state='removing' ORDER BY id")]

    def removed(self, rid: str) -> None:
        self._receipt(rid, "undone")

    # -- taps ----------------------------------------------------------------------------------------
    def on_choice(self, kind: str, target: str) -> str:
        """Plain words from templates; what the tap stores is fixed by the button."""
        rid, _, code = (target or "").rpartition(":")
        if kind == "meaning_answer" and code in ANSWERS:
            return self._answer(rid, code)
        if kind == "meaning_undo" and code in UNDOS:
            return self._undo(rid, code)
        if kind == "place_skip":
            return self.places.on_choice(kind, target)
        return "Nothing changed."

    def _example(self, f: dict, source: str, types: list[str], **kw) -> str:
        eid, new = meaning.add_example(self.ledger, source=source, said=" ".join(f["words"]),
                                       words=frozenset(f["words"]), who=f.get("who", ""),
                                       series=f.get("series", ""), types=types,
                                       month=f.get("month"), **kw)
        if new:
            meaning.rejudge_for(self.ledger, [eid])
            if self.shadow is not None:
                self.shadow.poke()
        return eid

    def _answer(self, qid: str, code: str) -> str:
        q = self.ledger.db.execute("SELECT * FROM meaning_questions WHERE id=?", (qid,)).fetchone()
        if q is None or q["state"] != "open":
            return "That question is closed. Nothing changed."
        now = iso(self.ledger.now())
        f = json.loads(q["features"])
        said = render.escape(q["said"])
        with self.ledger.tx() as db:
            db.execute("UPDATE meaning_questions SET state=?, answer=?, updated_at=? WHERE id=?",
                       ("answered" if code != "depends" else "depends", code, now, qid))
            if code == "depends":
                db.execute("INSERT INTO meaning_kinds(kind_key, ask_each_time, updated_at)"
                           " VALUES(?,1,?) ON CONFLICT(kind_key) DO UPDATE SET ask_each_time=1,"
                           " updated_at=excluded.updated_at", (q["kind_key"], now))
        if code == "depends":
            return f"Got it. I'll ask about each {said} as it comes up."
        if not q["each"]:
            # His answer about one occurrence, kept for the kind: what it means next time.
            if code == "no":
                self._example(f, "answer", [])
            elif q["ask"] == "presence":
                self._example(f, "answer", ["presence"], scope="part" if code == "part" else "")
            else:
                self._example(f, "answer", [q["ask"]], place=f.get("place", "none"))
        # What will happen, never a calendar that's already so: the block follows at the next read.
        return {"yes": f"Thanks. I'll put {said} on your calendar as yours.",
                "all": f"Thanks. I'll put {said} on your calendar as yours.",
                "part": f"Thanks. {said} ties you up for part of it.",
                "no": f"Thanks. I'll keep {said} off your calendar."}[code]

    def _undo(self, rid: str, code: str) -> str:
        r = self.ledger.db.execute("SELECT * FROM meaning_receipts WHERE id=?", (rid,)).fetchone()
        if r is None or r["state"] != "shown":
            return "Already done."
        f = json.loads(r["features"])
        if code == "not_mine":
            self._example(f, "undo", [])
        elif code == "wrong_time":
            self._example(f, "undo", [f["type"]], place=f.get("place", "none"), trusted=False)
        self._receipt(rid, "removing", code)
        said = render.escape(r["said"])
        return {"not_mine": f"Taking it off your Gmail. I'll leave {said} off from now on.",
                "wrong_time": f"Taking it off your Gmail. Next time {said} comes up, I'll ask first.",
                "once": "Taking it off your Gmail, just this once."}[code]

    # -- questions ---------------------------------------------------------------------------------
    def tick(self, *, paused: bool) -> None:
        """A bug here is a record, never a stopped loop."""
        try:
            self._revive()
            self._unseen()
            self._expire()
            if paused or self.chat_id is None or not self.on():
                return
            self._ask()
            self.places.ask(self.chat_id, self.ledger.now())    # where a named place is, once each
        except Exception as e:
            log.warning("meaning questions failed: %s", type(e).__name__)
            self.ledger.event("meaning_live_failed", {"error": type(e).__name__})

    def _revive(self) -> None:
        """Once: his answers wrongly overruled by a seeded example (meaning.revive_answers) come
        back, and every judgment any answer of his could touch is made again, so none still
        rests on what was judged before his answer counted. One that fails is tried again at
        the next read, not on every pass."""
        if self.ledger.get_meta("meaning_revived") == "2":
            return
        read = (getattr(self.calendar, "generation", None),)
        if self._revive_tried == read:
            return                         # failed at this read: tried again at the next one
        self._revive_tried = read
        ids = meaning.revive_answers(self.ledger)
        mine = [e.id for e in meaning.active_examples(self.ledger) if e.source not in meaning.SEEDED]
        n = meaning.rejudge_for(self.ledger, mine, only_unseen=True)   # judged without it
        if n and self.shadow is not None:
            self.shadow.poke()
        self.ledger.event("meaning_revived", {"n": len(ids), "rejudge": n})
        log.info("meaning: %d answers of his back in use; %d judgments to make again", len(ids), n)
        with self.ledger.tx() as db:
            self.ledger.set_meta("meaning_revived", "2", db)

    def _unseen(self) -> None:
        """Each pass: a judgment that never had an active answer of his in front of it, though
        one fits the event now, is made again with it. Self-healing for answers that arrived
        "already known" (no new answer, so nothing re-judged), or after the event was judged
        (Nov 10: the turkey harvest). Once seen, an answer never triggers this again. One
        already waiting to be made again is flagged once, not on every pass (Nov 11): until
        the judge reaches it (its event may be outside the read, or a limit hit), it gets no
        log line and no poke."""
        mine = [e.id for e in meaning.active_examples(self.ledger) if e.source not in meaning.SEEDED]
        n = meaning.rejudge_for(self.ledger, mine, only_unseen=True)
        if n:
            log.info("meaning: %d judgments made again with an answer of his they hadn't seen", n)
            if self.shadow is not None:
                self.shadow.poke()

    def _expire(self) -> None:
        now = iso(self.ledger.now())
        with self.ledger.tx() as db:
            db.execute("UPDATE meaning_questions SET state='expired', updated_at=? WHERE state='open'"
                       " AND (expires<=? OR starts<=?)", (now, now, now))

    def _gmail_busy(self, start: datetime, end: datetime) -> bool:
        """His own Gmail already has him busy for all of it. Not read is not busy."""
        feeds = getattr(getattr(self.calendar, "snapshot", None), "feeds", {}) or {}
        ahead = next((res.ahead for res in feeds.values() if getattr(res, "window", None) is not None
                      and res.window.calendar.casefold().endswith("@gmail.com")), None)
        if ahead is None or not ahead.occurrences or ahead.unreadable:
            return False
        return any(_is_real(o) and not o.all_day and not o.transparent and o.start <= start
                   and o.end >= end for o in ahead.occurrences)

    def _matters(self, j, ask: str, sp: meaning.Span, all_day: bool, now: datetime) -> bool:
        """Would his answer change when he's free in the next 14 days? Supervision or transport
        within 48 hours always does."""
        forced = _forced(j, _asked_types(ask), sp, all_day)
        windows = [(b.start, b.end) for b in meaning.blocks_for(forced, sp, now, supported=True)
                   if b.blocks == "meetings"]
        windows = [(s, e) for s, e in windows if e > now and s < now + ASK_AHEAD]
        if not windows:
            return False
        if ask in meaning.CRITICAL and any(s < now + URGENT for s, _ in windows):
            return True
        return not all(self._gmail_busy(s, e) for s, e in windows)

    def _candidates(self, now: datetime) -> list[tuple]:
        items = self.shadow.items if self.shadow is not None else None
        if not items:
            return []
        evs = meaning.events_of(items, self.tz, self.name_fn())
        examples = {e.id: e for e in meaning.active_examples(self.ledger)}
        each_kinds = {r["kind_key"] for r in self.ledger.db.execute(
            "SELECT kind_key FROM meaning_kinds WHERE ask_each_time=1")}
        asked = self.ledger.db.execute("SELECT kind_key, occurrence, ask, each FROM meaning_questions"
                                       ).fetchall()
        by_kind = {(r["kind_key"], r["ask"]) for r in asked if not r["each"]}
        by_occ = {(r["occurrence"], r["ask"]) for r in asked}
        dated = self._event_answers()
        out = []
        for ev in evs.values():
            row = meaning.stored(self.ledger, ev.key)
            if row is None or row["fingerprint"] != ev.fingerprint or row["stale"]:
                continue                   # waiting to be judged: ask once that's done
            j = meaning.judgment_of(row)
            if j is None:
                continue
            kk = kind_key(ev)
            each = kk in each_kinds
            if not each and meaning.supported(j, examples) and not j.unsure:
                continue                   # backed by his own answer: nothing to ask
            ask = ask_type(j)
            if ask is None:
                continue
            if not each and (kk, ask) in by_kind:
                continue                   # never the same question twice
            for item in sorted(ev.occurrences, key=lambda i: meaning.span_of(i.occ, self.tz).anchor):
                occ = item.occ
                sp = meaning.span_of(occ, self.tz)
                if sp.anchor <= now or sp.anchor >= now + ASK_AHEAD:
                    continue
                if (_occ_id(occ), ask) in by_occ:
                    continue
                if self._answer_for(occ, sp, {}, dated) is not None:
                    continue               # he answered about this very event in his record
                if not self._matters(j, ask, sp, occ.all_day, now):
                    continue
                out.append((sp.anchor, ev, item, ask, kk, each, j))
                break                      # one per kind: its next occurrence
        return sorted(out, key=lambda c: c[0])

    def _ask(self) -> None:
        now = self.ledger.now()
        open_rows = self.ledger.db.execute("SELECT kind_key FROM meaning_questions WHERE state='open'"
                                           ).fetchall()
        room = MAX_OPEN - len(open_rows)
        if room <= 0:
            return
        busy_kinds = {r["kind_key"] for r in open_rows}
        local = now.astimezone(ZoneInfo(self.tz))
        today = local.date().isoformat()
        batch_ok = self.ledger.get_meta("meaning_question_batch") != today and local.time() >= BATCH_FROM
        sent_batch = False
        for start, ev, item, ask, kk, each, j in self._candidates(now):
            if room <= 0:
                break
            if kk in busy_kinds:
                continue                   # one open question per kind of event
            urgent = start < now + URGENT
            if not urgent and not batch_ok:
                continue
            self._send(ev, item, ask, kk, each, j, now)
            busy_kinds.add(kk)
            room -= 1
            sent_batch = sent_batch or not urgent
        if sent_batch:
            with self.ledger.tx() as db:
                self.ledger.set_meta("meaning_question_batch", today, db)

    def _send(self, ev, item, ask: str, kk: str, each: bool, j, now: datetime) -> None:
        occ = item.occ
        sp = meaning.span_of(occ, self.tz)
        qid = secrets.token_hex(8)
        ttl = int(min(MAX_TTL_S, max(MIN_TTL_S, (sp.anchor - now).total_seconds())))
        features = {"words": sorted(family_rules.words(occ.summary)), "who": meaning.who_for(occ.summary),
                    "series": occ.uid if ev.kind == "series" else "", "month": sp.anchor.month,
                    "place": _place(j, ask) if ask in meaning.CRITICAL else "none"}
        text = question_text(ask, occ.summary, sp.anchor, occ.all_day)
        buttons = CRITICAL_BUTTONS if ask in meaning.CRITICAL else PRESENCE_BUTTONS
        stamp = iso(now)
        with self.ledger.tx() as db:
            nonces = [(label, choices.mint(self.ledger, kind="meaning_answer", target=f"{qid}:{code}",
                                           chat_id=self.chat_id, ttl_s=ttl, db=db))
                      for label, code in buttons]
            db.execute("INSERT INTO meaning_questions(id, kind_key, event_key, occurrence, ask, each,"
                       " said, features, starts, expires, state, answer, created_at, updated_at)"
                       " VALUES(?,?,?,?,?,?,?,?,?,?,'open','',?,?)",
                       (qid, kk, ev.key, _occ_id(occ), ask, int(each), meaning.shown(occ.summary),
                        json.dumps(features), iso(sp.anchor), iso(now + timedelta(seconds=ttl)),
                        stamp, stamp))
            self.ledger.enqueue(chat_id=self.chat_id, kind="reply", text=render.fit(text), db=db,
                                buttons=[[(label, choices.callback_data(n)) for label, n in nonces]],
                                binds=[{"type": "choice", "nonce": n} for _, n in nonces])
            self.ledger.event("meaning_asked", {"ask": ask, "each": int(each)}, db=db)

    # -- what he told Cain ------------------------------------------------------------------------
    def import_rows(self, rows: list[dict]) -> tuple[int, int]:
        """Rows already checked (validate_rows). Oldest first, so his newest word for a kind
        wins. The same table again stores nothing new. Returns (new, already known)."""
        added = known = 0
        new_ids = []
        # His dated answers: the whole set each time, as the record holds them now.
        dated = {(" ".join(r["words"]), r["for"]): r for r in rows if r.get("for")}
        with self.ledger.tx() as db:
            had = {(r["words"], r["day"], r["meaning"]) for r in db.execute(
                "SELECT words, day, meaning FROM meaning_event_answers")}
            db.execute("DELETE FROM meaning_event_answers")
            for (words, day), r in sorted(dated.items(), key=lambda kv: kv[1]["said_on"]):
                db.execute("INSERT OR REPLACE INTO meaning_event_answers(words, day, meaning, said_on)"
                           " VALUES(?,?,?,?)", (words, day, r["meaning"], r["said_on"]))
        changed = had != {(w, d, r["meaning"]) for (w, d), r in dated.items()}
        for row in sorted(rows, key=lambda r: r["said_on"]):
            types, place = MEANINGS[row["meaning"]]
            words = frozenset(row["words"])
            eid, new = meaning.add_example(self.ledger, source=SOURCE_CAIN, said=" ".join(row["words"]),
                                           words=words, types=list(types), place=place,
                                           said_on=row["said_on"])
            if new:
                added += 1
                new_ids.append(eid)
            else:
                known += 1
        if new_ids:
            meaning.rejudge_for(self.ledger, new_ids)
        if new_ids or changed:
            if self.shadow is not None:
                self.shadow.poke()
            self.ledger.event("meaning_imported", {"new": added, "known": known,
                                                   "dated": len(dated)})
        return added, known
