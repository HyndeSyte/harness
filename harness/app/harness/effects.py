"""Effects: the only things the harness can ever do to the world.

Default-deny. An effect type that is not defined here does not exist,
whatever a model writes. The model supplies only `effect_type` and the
small set of parameters a definition declares; everything that decides
safety -- reversibility, preconditions, expiry, the resource it may
touch, whether a second model must review it, how to undo it, and what
happens if the remote call succeeded but the Pi died before recording
it -- is fixed here, in code, and versioned with the policy.

v1.4 staging: S0 and S1 have no live effects. The first, a private hold
on the calendar the harness itself created, unlocks at S2.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable


class ParamError(ValueError):
    pass


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
