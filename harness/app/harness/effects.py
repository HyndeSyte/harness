"""Effects: the only things the harness can ever do to the world.

Default-deny. An effect type that is not defined here does not exist,
whatever a model writes. The model supplies only `effect_type` and the
small set of parameters a definition declares; everything that decides
safety -- reversibility, preconditions, expiry, the resource it may
touch, whether a second model must review it, how to undo it, and what
happens if the remote call succeeded but the Pi died before recording
it -- is fixed here, in code, and versioned with the policy.

v1.4 staging: S0 has no live effects. A private hold on the calendar the
harness itself created unlocks at S2. The one exception is family_event_add,
registered at S1 behind a switch of its own (family_add.py): it stays off
until his tap, and it does not move the stage.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

FAMILY_ADD = "family_event_add"


class ParamError(ValueError):
    pass


class PlainRefusal(ParamError):
    """A refusal he should hear in plain words, not as a malformed reply."""


@dataclass(frozen=True)
class Param:
    kind: str                                # "datetime" | "int" | "str"
    required: bool = True
    minimum: int | None = None
    maximum: int | None = None
    max_len: int | None = None
    pattern: str | None = None

    def check(self, name: str, value: Any) -> Any:
        if self.kind == "int":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ParamError(f"{name}: integer required")
            if self.minimum is not None and value < self.minimum:
                raise ParamError(f"{name}: below {self.minimum}")
            if self.maximum is not None and value > self.maximum:
                raise ParamError(f"{name}: above {self.maximum}")
            return value
        if self.kind == "str":
            if not isinstance(value, str):
                raise ParamError(f"{name}: string required")
            if self.max_len is not None and len(value) > self.max_len:
                raise ParamError(f"{name}: longer than {self.max_len}")
            if self.pattern and not re.fullmatch(self.pattern, value):
                raise ParamError(f"{name}: wrong format")
            return value
        if self.kind == "datetime":
            if not isinstance(value, str):
                raise ParamError(f"{name}: ISO datetime string required")
            try:
                dt = datetime.fromisoformat(value)
            except ValueError as exc:
                raise ParamError(f"{name}: not an ISO datetime") from exc
            if dt.tzinfo is None:
                # A time without a zone is two different times on a
                # travel week. Refused rather than guessed.
                raise ParamError(f"{name}: timezone required")
            return value
        raise ParamError(f"{name}: unknown param kind {self.kind}")


@dataclass(frozen=True)
class EffectDef:
    name: str
    min_stage: str
    reversible: bool
    ttl_s: int
    reviewer_required: bool
    params: dict[str, Param]
    # Fixed by the controller, never by the model:
    fixed: dict[str, Any] = field(default_factory=dict)
    undo: str = ""
    idempotency: str = ""
    preconditions: tuple[Callable[[dict], str | None], ...] = ()
    # "model": a model may propose it (schema/runner path). "controller":
    # only plain controller code may build it; a model naming it is refused.
    origin: str = "model"
    # Cross-field check on validated params (None when fine).
    shape: Callable[[dict], str | None] | None = None

    def validate(self, params: Any) -> dict:
        if not isinstance(params, dict):
            raise ParamError("params must be an object")
        unknown = set(params) - set(self.params)
        if unknown:
            # A model that tries to set the calendar, the title, the
            # attendees or anything else not declared here is refused
            # whole, not trimmed.
            raise ParamError(f"undeclared params: {sorted(unknown)}")
        out = {}
        for name, spec in self.params.items():
            if name not in params:
                if spec.required:
                    raise ParamError(f"{name}: required")
                continue
            out[name] = spec.check(name, params[name])
        if self.shape is not None:
            why = self.shape(out)
            if why:
                raise ParamError(why)
        return out


def _mirror_shape(p: dict) -> str | None:
    if p["op"] == "delete":
        extra = set(p) - {"op", "event_id"}
        return f"delete takes only event_id, not {sorted(extra)}" if extra else None
    missing = {"start", "end", "title"} - set(p)
    if missing:
        return f"{p['op']} needs {sorted(missing)}"
    from datetime import datetime as _dt
    if _dt.fromisoformat(p["end"]) <= _dt.fromisoformat(p["start"]):
        return "end must be after start"
    return None


# Letters by category but drawn as nothing, and the object placeholder.
_BLANK_LOOKING = frozenset({0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0,
                            0x1D159, 0xFFFC})
_ZWJ, _ZWNJ, _VS16 = "\u200d", "\u200c", "\ufe0f"
_YEARS = (2000, 2100)    # far enough for any real event, and safe to convert between zones


def _joiner_fits(value: str, i: int) -> bool:
    """The two joiners real text uses: U+200D between emoji, U+200C between
    letters of Arabic script (Persian needs it). Anywhere else they are hidden."""
    before = value[:i].rstrip(_VS16)[-1:]
    after = value[i + 1:i + 2]
    if not before or not after:
        return False
    if value[i] == _ZWJ:
        return unicodedata.category(before) in ("So", "Sk") and unicodedata.category(after) == "So"
    return 0x0600 <= ord(before) <= 0x06FF and 0x0600 <= ord(after) <= 0x06FF


def _plain_text(value: str) -> bool:
    """No control, format, line-separator, private-use or unassigned characters,
    nothing unpaired and nothing invisible: nothing that could start a new calendar
    property, fake a line on a card, or make a card read differently from what is
    written."""
    for i, c in enumerate(value):
        if c in (_ZWJ, _ZWNJ):
            if not _joiner_fits(value, i):
                return False
        elif unicodedata.category(c) in ("Cc", "Cf", "Cs", "Zl", "Zp", "Cn", "Co") \
                or ord(c) in _BLANK_LOOKING:
            return False
    return True


def _visible(value: str) -> bool:
    """At least one letter, digit or symbol. _plain_text has refused the blank-looking ones."""
    return any(unicodedata.category(c)[0] in "LNS" for c in value)


def _family_shape(p: dict) -> str | None:
    title, location = p["title"], p.get("location", "")
    if not _plain_text(title) or not _plain_text(location):
        raise PlainRefusal("the title or location has an invisible or special character "
                           "I can't show you exactly on a card")
    if not _visible(title):
        raise PlainRefusal("the title is blank")
    if location.strip() and not _visible(location):
        raise PlainRefusal("the location is blank")
    start, end = datetime.fromisoformat(p["start"]), datetime.fromisoformat(p["end"])
    for dt in (start, end):
        if not _YEARS[0] <= dt.year <= _YEARS[1]:
            raise PlainRefusal(f"the year has to be between {_YEARS[0]} and {_YEARS[1]}")
        if dt.second or dt.microsecond:
            raise PlainRefusal("the times have to be whole minutes")  # the card shows no seconds
    if end <= start:
        raise PlainRefusal("the end has to be after the start")
    return None


def _future(params: dict) -> str | None:
    # Evaluated by the executor against its own clock at execution time.
    return None


REGISTRY: dict[str, EffectDef] = {
    "calendar_hold": EffectDef(
        name="calendar_hold",
        min_stage="S2",
        reversible=True,
        ttl_s=12 * 3600,
        reviewer_required=False,
        params={
            "start": Param("datetime"),
            "duration_min": Param("int", minimum=15, maximum=480),
        },
        # The model never chooses where or what: one calendar the harness
        # created (scope calendar.app.created makes Google enforce it), a
        # non-sensitive title, no attendees, no recurrence.
        fixed={"calendar": "harness-created", "title": "Reserved",
               "attendees": (), "recurrence": ()},
        undo="delete the event by its id within 24 h",
        idempotency=("event id derived from the effect id; before any retry, "
                     "look the event up by id; a re-create after an undo gets "
                     "a new id because deleted ids leave a tombstone"),
    ),
    # Work-hours mirror (workmirror.py, decided 2026-10-08). Built only by
    # the controller from his configured rules, from a reconcile of the plan
    # against the live copies; each card's tap approves its exact operations.
    # A model can't propose it. His own events are never edited.
    "work_mirror_copy": EffectDef(
        name="work_mirror_copy",
        min_stage="S2",
        reversible=True,
        ttl_s=72 * 3600,
        reviewer_required=False,
        params={
            "op": Param("str", pattern=r"add|update|delete"),
            "event_id": Param("str", pattern=r"m1[0-9a-v]{20,120}"),
            "start": Param("datetime", required=False),
            "end": Param("datetime", required=False),
            "title": Param("str", required=False, max_len=200),
        },
        # The attendee is his configured work address, filled in by the
        # executor from config at execution time, never from params.
        fixed={"calendar": "harness-created", "visibility": "private",
               "attendees": ("config:work_mirror.work_address",), "recurrence": (),
               # Notifications stay on their own side (his rule, 2026-10-08):
               # no email to a Google work guest (externalOnly still emails a
               # non-Google calendar, which needs it to get the event at all),
               # and no reminders on the copy, so his personal devices don't
               # buzz twice. The work side stays quiet by his work calendar's
               # "notify only if I responded Yes or Maybe" with the invite left
               # unanswered; the organizer can't set a guest's reminders.
               "conference": None, "send_updates": "externalOnly", "transparency": "opaque",
               "description": "", "location": "", "reminders": (),
               "reminders_use_default": False,
               "guests_can_invite_others": False, "guests_can_see_other_guests": False},
        undo="delete the copy by its id; a Google work calendar drops it without an email",
        idempotency=("event id comes from the plan (hash of source and occurrence id); "
                     "insert with that id. On a conflict, GET it: confirmed and matching "
                     "means done; cancelled (a tombstone left by an earlier undo) means "
                     "patch it back to confirmed with these fields, never 'already done'"),
        origin="controller",
        shape=_mirror_shape,
    ),
    # One event on iCloud Family (family_add.py, caldav.py). A model may propose
    # it; the title, times and location are all it can say. Being registered
    # at S1 lets it be proposed, not done: it also needs his own switch on, and
    # a tap on its card until he has said otherwise after the bake-in.
    FAMILY_ADD: EffectDef(
        name=FAMILY_ADD,
        min_stage="S1",
        reversible=True,
        ttl_s=12 * 3600,
        reviewer_required=False,
        params={
            "title": Param("str", max_len=200),
            "start": Param("datetime"),
            "end": Param("datetime"),
            "location": Param("str", required=False, max_len=200),
        },
        fixed={"calendar": "Family", "marker": "X-HARNESS-OWNED", "attendees": (),
               "organizer": None, "alarms": (), "recurrence": ()},
        undo="delete that event, once, if its ETag is still the one the harness wrote",
        idempotency=("uid derived from the effect id and PUT with If-None-Match: *, so a "
                     "repeat is refused by the server and can't be a second event; "
                     "a lost response is reported as unknown and never retried"),
        shape=_family_shape,
    ),
    # Keeping Family true to the Gmail calendar (family_copy.py). Built only by plain
    # code, with no tap, after he turned it on by entering his name. A model can't
    # propose it. It carries fixed words and times, never text from Gmail, and it
    # changes only its own copies and plain one-offs of his it took over.
    "family_copy_sync": EffectDef(
        name="family_copy_sync",
        min_stage="S1",
        reversible=True,
        ttl_s=0,
        reviewer_required=False,
        params={},
        fixed={"calendar": "Family", "marker": "X-HARNESS-OWNED", "attendees": (),
               "organizer": None, "alarms": (), "recurrence": ()},
        undo="delete it on the calendar; a copy removed by anyone is not put back",
        idempotency="uid fixed per copy, PUT with If-None-Match: * or If-Match, so no doubles",
        origin="controller",
    ),
}


def lookup(effect_type: str, stage_at_least: Callable[[str], bool], *,
           origin: str = "model") -> EffectDef:
    d = REGISTRY.get(effect_type)
    if d is None:
        raise ParamError(f"unknown effect type {effect_type!r}")
    if d.origin != origin:
        # A model that names a controller-only effect gets the same answer
        # as one that names an effect that doesn't exist.
        raise ParamError(f"unknown effect type {effect_type!r}")
    if not stage_at_least(d.min_stage):
        raise ParamError(f"{effect_type} is not enabled before {d.min_stage}")
    return d
